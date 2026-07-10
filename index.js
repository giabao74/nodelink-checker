require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } = require('discord.js');
const { LavalinkManager } = require('lavalink-client');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', true); // Trust reverse proxy headers (Render, Heroku, Cloudflare) for correct HTTPS protocol redirect_uri

const PORT = process.env.PORT || 3000;

// Webhook config
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1524995367308099686/X6wOlHw4wi2rDCcB38sm5dXufIiiDnAO1jYNkRu2hkl7CmokFToWVZY9v3aqX7bWN389";
const WEBHOOK_REPORT_INTERVAL = 5 * 1000; // 5 seconds (as requested by user)

// Supabase client initialization
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

// In-memory session store
const activeSessions = new Map();
let lastWebhookMessageId = null;

// Global configurations
const i18n = {
    en: {
        status_title: "🟢 NodeLink Cluster Status",
        not_connected: "❌ Node is not connected.",
        players: "Players", cpu: "CPU Load", ram: "RAM Usage", uptime: "Uptime",
        footer: "NodeLink Keeper System • Auto-updates every 5 seconds",
        refresh_btn: "🔄 Refresh"
    },
    vi: {
        status_title: "🟢 Trạng thái Hệ thống NodeLink",
        not_connected: "❌ Node chưa kết nối.",
        players: "Người dùng", cpu: "Tải CPU", ram: "Dung lượng RAM", uptime: "Uptime",
        footer: "Hệ thống Giữ sống NodeLink • Tự cập nhật mỗi 5 giây",
        refresh_btn: "🔄 Làm mới"
    }
};

const youtubeUrls = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=9bZkp7q19f0",
    "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
    "https://www.youtube.com/watch?v=JGwWNGJdvx8"
];

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const startTime = Date.now();
const statusMessages = new Map();

// ✅ Auto-update đổi từ 5 phút → 5 giây để đồng bộ
const REFRESH_INTERVAL = 5 * 1000; // 5000ms = 5 giây
const KEEPALIVE_INTERVAL = 60000; // keep-alive NodeLink vẫn giữ 60s để node không bị sleep

let isFullyBooted = false;
let lavalinkManager = null;
let myNodes = [];

// Cookie parser helper
function getCookie(req, name) {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;
    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
        const [key, value] = cookie.split('=').map(c => c.trim());
        if (key) acc[key] = value;
        return acc;
    }, {});
    return cookies[name] || null;
}

// Redirect to Discord OAuth
function redirectToDiscord(req, res) {
    const redirectUri = req.protocol + '://' + req.get('host') + '/api/auth/discord/callback';
    const clientId = process.env.CLIENT_ID || (client.user ? client.user.id : '');
    if (!clientId) {
        return res.status(500).send('<h1>Configuration Error</h1><p>CLIENT_ID is missing in .env. Please configure it to allow Discord login.</p>');
    }
    const authorizeUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.redirect(authorizeUrl);
}

// Helper to check if a request is authenticated as an admin
async function isReqAdmin(req) {
    const token = getCookie(req, 'session_token');
    if (!token) return false;
    
    const session = activeSessions.get(token);
    if (!session || session.expires < Date.now()) {
        if (session) activeSessions.delete(token);
        return false;
    }
    
    const allowedUserIds = ['1262304052361035857', '1092773378101882951'];
    const envAdminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
    const allAdminIds = [...allowedUserIds, ...envAdminIds];
    
    // Fetch bot application info to get owner if not cached
    if (!client.application) {
        try {
            await client.application.fetch();
        } catch (e) {
            // ignore
        }
    }
    
    const isOwner = client.application?.owner?.id === session.userId || client.application?.owner?.members?.has(session.userId);
    return isOwner || allAdminIds.includes(session.userId);
}

// Admin Authorization Middleware
const adminAuthMiddleware = async (req, res, next) => {
    try {
        const token = getCookie(req, 'session_token');
        if (!token) return redirectToDiscord(req, res);
        
        const session = activeSessions.get(token);
        if (!session || session.expires < Date.now()) {
            if (session) activeSessions.delete(token);
            return redirectToDiscord(req, res);
        }
        
        const isAdmin = await isReqAdmin(req);
        if (!isAdmin) {
            return res.status(403).send('<h1>403 Forbidden</h1><p>You are not authorized to view this page. Access is restricted to designated administrators only.</p>');
        }
        
        req.session = session;
        next();
    } catch (e) {
        next(e);
    }
};

// Express Global Middleware
app.use(express.json());

// Serve static dashboard files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/404', (req, res) => res.sendFile(path.join(__dirname, 'public', '404.html')));

app.get(['/admin', '/prmgvyt'], adminAuthMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// OAuth Callback Route
app.get('/api/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/404');
    
    const redirectUri = req.protocol + '://' + req.get('host') + '/api/auth/discord/callback';
    
    try {
        const clientSecret = process.env.DISCORD_CLIENT_SECRET;
        const clientId = process.env.CLIENT_ID || (client.user ? client.user.id : '');
        
        if (!clientSecret) {
            return res.status(500).send('<h1>Configuration Error</h1><p>DISCORD_CLIENT_SECRET is missing in .env. Please configure it to allow Discord login.</p>');
        }
        
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
            }),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
        
        const tokenData = await tokenResponse.json();
        if (tokenData.error) {
            console.error("OAuth token error:", tokenData);
            return res.status(400).send(`<h1>Auth Error</h1><p>${tokenData.error_description || tokenData.error}</p>`);
        }
        
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: {
                authorization: `${tokenData.token_type} ${tokenData.access_token}`,
            },
        });
        
        const userData = await userResponse.json();
        const userId = userData.id;
        
        // Fetch bot application info to get owner
        if (!client.application) {
            await client.application.fetch();
        }
        
        const allowedUserIds = ['1262304052361035857', '1092773378101882951'];
        const envAdminIds = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
        const allAdminIds = [...allowedUserIds, ...envAdminIds];
        
        const isOwner = client.application?.owner?.id === userId || client.application?.owner?.members?.has(userId);
        const isAdmin = isOwner || allAdminIds.includes(userId);
        
        if (!isAdmin) {
            return res.status(403).send('<h1>403 Forbidden</h1><p>You are not authorized to access the admin panel. Your Discord ID is not in the Admin list.</p>');
        }
        
        const sessionToken = crypto.randomBytes(32).toString('hex');
        activeSessions.set(sessionToken, {
            userId,
            username: userData.username,
            avatar: userData.avatar,
            expires: Date.now() + 24 * 60 * 60 * 1000
        });
        
        res.cookie('session_token', sessionToken, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 });
        res.redirect('/admin');
    } catch (err) {
        console.error("Auth callback error:", err);
        res.status(500).send('<h1>Internal Server Error</h1><p>Authentication failed.</p>');
    }
});

// User session profile info API
app.get('/api/auth/me', adminAuthMiddleware, (req, res) => {
    res.json(req.session);
});

// Logout endpoint
app.get('/api/auth/logout', (req, res) => {
    const token = getCookie(req, 'session_token');
    if (token) activeSessions.delete(token);
    res.clearCookie('session_token');
    res.redirect('/');
});

// Node dynamic management APIs
app.get('/api/nodes', adminAuthMiddleware, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    try {
        const { data, error } = await supabase.from('nodelinks').select('*').order('created_at', { ascending: true });
        if (error) return res.status(500).json({ error: error.message });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/nodes', adminAuthMiddleware, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    const { host, port, password, secure } = req.body;
    if (!host) return res.status(400).json({ error: "Host is required" });
    
    try {
        const { data, error } = await supabase.from('nodelinks').insert([{
            host: parseHost(host),
            port: parseInt(port) || 2333,
            password: password || 'youshallnotpass',
            secure: secure === true
        }]).select();
        
        if (error) return res.status(500).json({ error: error.message });
        
        // Dynamically sync nodes instantly
        await syncNodesWithDb();
        
        res.json({ success: true, node: data[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/nodes/:id', adminAuthMiddleware, async (req, res) => {
    if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
    const nodeId = req.params.id;
    
    try {
        const { error } = await supabase.from('nodelinks').delete().eq('id', nodeId);
        if (error) return res.status(500).json({ error: error.message });
        
        // Dynamically sync nodes instantly
        await syncNodesWithDb();
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// JSON API Endpoint for Dashboard
app.get('/api/status', async (req, res) => {
    if (!lavalinkManager || !lavalinkManager.nodeManager) {
        return res.status(503).json({ error: "Lavalink Manager is initializing..." });
    }

    const isAdmin = await isReqAdmin(req);
    const nodes = Array.from(lavalinkManager.nodeManager.nodes.values());
    const connectedNodes = nodes.filter(node => node && node.connected === true);
    
    let totalPlayers = 0;
    let totalRamUsed = 0; // in MB
    let totalCpuLoad = 0;
    
    connectedNodes.forEach(node => {
        const stats = node.stats || {};
        totalPlayers += stats.players || 0;
        if (stats.memory?.used) {
            totalRamUsed += stats.memory.used / 1024 / 1024;
        }
        totalCpuLoad += formatCpuPercent(stats);
    });
    
    const avgCpuLoad = connectedNodes.length > 0 ? (totalCpuLoad / connectedNodes.length).toFixed(2) : '0.00';
    
    const nodeStatusList = nodes.map((node, index) => {
        const stats = node.stats || {};
        const usedRam = stats.memory?.used ? (stats.memory.used / 1024 / 1024).toFixed(2) : '0.00';
        const totalRam = stats.memory?.allocated ? (stats.memory.allocated / 1024 / 1024).toFixed(2) : '0.00';
        
        // Use node.heartBeatPing for accurate websocket latency (rounded to 1 decimal place)
        const pingTime = (node.connected && typeof node.heartBeatPing === 'number' && node.heartBeatPing >= 0) ? parseFloat(node.heartBeatPing.toFixed(1)) : null;
        const normalizedCpu = formatCpuPercent(stats).toFixed(2);

        // Masking connection details if NOT Admin
        const hostString = isAdmin ? `${node.options.host}:${node.options.port}` : getMaskedHost(node.options.host, node.options.port);
        const displayHost = isAdmin ? node.options.host : '🔒 Private';
        const displayPort = isAdmin ? node.options.port : '*****';

        return {
            id: `Node ${index + 1}`, // Clean node names (Node 1, Node 2...)
            host: displayHost,
            port: displayPort,
            hostString: hostString,
            connected: node.connected === true,
            ping: pingTime,
            stats: node.connected ? {
                players: stats.players || 0,
                cpuLoad: normalizedCpu,
                ramUsed: usedRam,
                ramTotal: totalRam,
                uptime: stats.uptime ? formatUptime(stats.uptime) : 'N/A'
            } : null
        };
    });

    res.json({
        botUptime: formatUptime(Date.now() - startTime),
        cluster: {
            totalNodes: nodes.length,
            onlineNodes: connectedNodes.length,
            offlineNodes: nodes.length - connectedNodes.length,
            totalPlayers,
            totalRamUsed: totalRamUsed.toFixed(2),
            avgCpuLoad
        },
        nodes: nodeStatusList
    });
});

// Catch-all 404 middleware - redirect to 404 page (must be registered after all routes)
app.use((req, res) => res.status(404).redirect('/404'));

app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));

function parseHost(raw) {
    return (raw || '').replace(/^https?:\/\//, '').split(':')[0];
}

function formatUptime(ms) {
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

// Normalized CPU calculator (0% - 100%) - accounts for multi-core environments
function formatCpuPercent(stats) {
    const raw = stats.cpu?.systemLoad ?? stats.cpu?.lavalinkLoad ?? 0;
    const cores = stats.cpu?.cores || 1;
    // If raw load is > 1.0, it is likely absolute load across all cores. Normalize by dividing by cores count.
    const cpuPercent = (raw > 1.0 && cores > 1) ? (raw / cores) * 100 : raw * 100;
    return Math.min(Math.max(cpuPercent, 0), 100);
}

function formatCpuLoad(stats) {
    const percent = formatCpuPercent(stats);
    return `${percent.toFixed(2)}%`;
}

// Securely mask node connection string for regular users (now completely hidden)
function getMaskedHost(host, port) {
    return "🔒 Private Connection";
}

function getStatusEmbed(lang) {
    const t = i18n[lang];
    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle(t.status_title)
        .setFooter({ text: t.footer })
        .setTimestamp();
    embed.addFields({
        name: `⏱️ ${t.uptime}`,
        value: `\`${formatUptime(Date.now() - startTime)}\``,
        inline: false
    });
    if (!lavalinkManager || !lavalinkManager.nodeManager) {
        embed.setDescription("⏳ Initializing node connections...");
        return embed;
    }
    const nodes = Array.from(lavalinkManager.nodeManager.nodes.values());
    nodes.forEach((node, index) => {
        const nodeName = node.options.id || `Node ${index + 1}`;
        if (!node || node.connected !== true) {
            embed.addFields({
                name: `🔴 ${nodeName}`,
                value: `\`\`\`${t.not_connected}\`\`\``,
                inline: false
            });
            return;
        }
        const stats = node.stats || {};
        const cpuDisplay = formatCpuLoad(stats);
        const usedRam = stats.memory?.used ? (stats.memory.used / 1024 / 1024).toFixed(2) : '0.00';
        embed.addFields({
            name: `🟢 ${nodeName}`,
            value: `**${t.players}:** ${stats.players || 0}\n**${t.cpu}:** ${cpuDisplay}\n**${t.ram}:** ${usedRam} MB`,
            inline: true
        });
    });
    return embed;
}

function getControlRow(lang) {
    const t = i18n[lang];
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('lang_en')
            .setLabel('🇬🇧 English')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('lang_vi')
            .setLabel('🇻🇳 Tiếng Việt')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('refresh_status')
            .setLabel(t.refresh_btn)
            .setStyle(ButtonStyle.Primary)
    );
}

function updatePresence() {
    try {
        if (!lavalinkManager || !lavalinkManager.nodeManager) return;
        const nodes = Array.from(lavalinkManager.nodeManager.nodes.values());
        const connectedNodes = nodes.filter(node => node && node.connected === true).length;
        const totalNodes = nodes.length;
        let totalPlayers = 0;
        nodes.forEach(node => {
            if (node && node.connected === true) {
                totalPlayers += node.stats?.players || 0;
            }
        });
        client.user.setPresence({
            status: 'online',
            activities: [{
                name: `Nodes: ${connectedNodes}/${totalNodes} | Players: ${totalPlayers}`,
                type: ActivityType.Watching
            }]
        });
        console.log(`🔄 Presence updated: Nodes: ${connectedNodes}/${totalNodes} online | Players: ${totalPlayers}`);
    } catch (e) {
        console.error('⚠️ Failed to update presence:', e.message);
    }
}

async function getNodesFromSupabase() {
    if (!supabase) return null;
    try {
        console.log("ℹ️ Fetching nodelinks from Supabase...");
        const { data, error } = await supabase
            .from('nodelinks')
            .select('*');
        
        if (error) {
            console.error("⚠️ Error fetching nodes from Supabase:", error.message);
            return null;
        }
        
        if (data && data.length > 0) {
            return data.map((n, index) => ({
                id: `Node ${index + 1}`, // Clean ID format
                host: parseHost(n.host),
                port: parseInt(n.port) || 2333,
                authorization: n.password || n.authorization || "youshallnotpass",
                secure: n.secure === true || String(n.secure) === "true" || parseInt(n.port) === 443
            }));
        }
    } catch (e) {
        console.error("⚠️ Failed to connect to Supabase database:", e.message);
    }
    return null;
}

function buildNodesFromEnv() {
    // 1. Check NODES_JSON
    if (process.env.NODES_JSON) {
        try {
            const parsed = JSON.parse(process.env.NODES_JSON);
            if (Array.isArray(parsed) && parsed.length > 0) {
                console.log("ℹ️ Loaded nodes configuration from NODES_JSON");
                return parsed.map((n, index) => ({
                    id: `Node ${index + 1}`,
                    host: parseHost(n.host),
                    port: parseInt(n.port) || 2333,
                    authorization: n.authorization || n.password || "youshallnotpass",
                    secure: n.secure === true || String(n.secure) === "true" || parseInt(n.port) === 443
                }));
            }
        } catch (e) {
            console.error("⚠️ Failed to parse NODES_JSON, falling back. Error:", e.message);
        }
    }

    // 2. Check NODELINKS
    if (process.env.NODELINKS) {
        try {
            const parts = process.env.NODELINKS.split(',');
            const nodes = parts.map((part, index) => {
                const subParts = part.trim().split(':');
                const host = parseHost(subParts[0]);
                let port = 2333;
                let password = "youshallnotpass";
                let secure = false;

                if (subParts.length >= 2) {
                    port = parseInt(subParts[1]) || 2333;
                }
                if (subParts.length >= 3) {
                    password = subParts[2];
                }
                if (subParts.length >= 4) {
                    secure = subParts[3] === "true";
                } else if (port === 443 || host.endsWith('onrender.com')) {
                    secure = true;
                }

                return {
                    id: `Node ${index + 1}`,
                    host,
                    port,
                    authorization: password,
                    secure
                };
            });
            if (nodes.length > 0) {
                console.log(`ℹ️ Loaded ${nodes.length} node(s) configuration from NODELINKS`);
                return nodes;
            }
        } catch (e) {
            console.error("⚠️ Failed to parse NODELINKS, falling back. Error:", e.message);
        }
    }

    // 3. Fallback to legacy NODE{n}_HOST
    const nodeIndexes = new Set();
    const regex = /^NODE(\d+)_HOST$/;
    for (const key of Object.keys(process.env)) {
        const match = key.match(regex);
        if (match) nodeIndexes.add(parseInt(match[1]));
    }
    if (nodeIndexes.size > 0) {
        console.log(`ℹ️ Loaded nodes from legacy NODE{n}_HOST variables`);
        const sortedIndexes = Array.from(nodeIndexes).sort((a, b) => a - b);
        return sortedIndexes.map((i, index) => ({
            id: `Node ${index + 1}`,
            host: parseHost(process.env[`NODE${i}_HOST`]),
            port: parseInt(process.env[`NODE${i}_PORT`]) || 2333,
            authorization: process.env[`NODE${i}_PASSWORD`] || "youshallnotpass",
            secure: process.env[`NODE${i}_SECURE`] === "true" || parseInt(process.env[`NODE${i}_PORT`]) === 443
        }));
    }

    console.warn("⚠️ Không tìm thấy bất kỳ cấu hình node nào trong env! Dùng node mặc định 127.0.0.1");
    return [{
        id: "Node 1",
        host: "127.0.0.1",
        port: 2333,
        authorization: "youshallnotpass",
        secure: false
    }];
}

async function syncNodesWithDb() {
    if (!lavalinkManager || !lavalinkManager.nodeManager) return;
    try {
        const dbNodes = await getNodesFromSupabase();
        if (!dbNodes || dbNodes.length === 0) return; // Skip if database is empty or failed

        const currentNodes = Array.from(lavalinkManager.nodeManager.nodes.values());

        // 1. Remove nodes that are no longer in the DB
        for (const node of currentNodes) {
            const exists = dbNodes.some(dbN => dbN.host === node.options.host && dbN.port === node.options.port);
            if (!exists) {
                console.log("🗑️ Dynamically deleting node connection:", node.options.id);
                try {
                    await lavalinkManager.nodeManager.deleteNode(node.options.id);
                } catch (err) {
                    console.error(`❌ Failed to delete node ${node.options.id}:`, err.message);
                }
            }
        }

        // 2. Add nodes that are in the DB but not active
        for (const dbNode of dbNodes) {
            const exists = currentNodes.some(node => node.options.host === dbNode.host && node.options.port === dbNode.port);
            if (!exists) {
                console.log(`➕ Dynamically adding node connection: ${dbNode.id}`);
                try {
                    lavalinkManager.nodeManager.createNode({
                        id: dbNode.id,
                        host: dbNode.host,
                        port: dbNode.port,
                        authorization: dbNode.authorization,
                        secure: dbNode.secure
                    });
                    const node = lavalinkManager.nodeManager.getNode(dbNode.id);
                    if (node) await node.connect();
                } catch (err) {
                    console.error(`❌ Failed to add/connect node ${dbNode.id}:`, err.message);
                }
            }
        }
        
        updatePresence();
    } catch (e) {
        console.error("⚠️ Failed to sync nodes with DB:", e.message);
    }
}

// Supabase Activity Keep-Alive to prevent database from going inactive (runs every 12 hours)
async function runSupabaseKeepAlive() {
    if (!supabase) return;
    try {
        const { error } = await supabase
            .from('keepalive')
            .upsert([{ id: 1, last_ping: new Date().toISOString() }]);
        
        if (error) {
            console.error("⚠️ Supabase Keep-Alive failed:", error.message);
        } else {
            console.log("⚡ Supabase Keep-Alive pinged successfully.");
        }
    } catch (err) {
        console.error("⚠️ Supabase Keep-Alive error:", err.message);
    }
}

// Supabase helper to load and save last webhook message id
async function loadWebhookMessageIdFromDb() {
    if (!supabase) return;
    try {
        const { data, error } = await supabase
            .from('keepalive')
            .select('webhook_msg_id')
            .eq('id', 1)
            .single();
        
        if (!error && data && data.webhook_msg_id) {
            lastWebhookMessageId = data.webhook_msg_id;
            console.log(`ℹ️ Loaded last webhook message ID from Supabase: ${lastWebhookMessageId}`);
        }
    } catch (e) {
        // Fail silently
    }
}

async function saveWebhookMessageIdToDb(msgId) {
    if (!supabase) return;
    try {
        await supabase
            .from('keepalive')
            .upsert([{ id: 1, webhook_msg_id: msgId }]);
    } catch (e) {
        // Fail silently
    }
}

// Discord Webhook Helper Functions
async function sendWebhookMessage(payload, isEdit = false) {
    if (!WEBHOOK_URL || WEBHOOK_URL.includes("your-webhook-id")) return null;
    
    try {
        let url = WEBHOOK_URL;
        let method = 'POST';
        
        if (isEdit && lastWebhookMessageId) {
            url = `${WEBHOOK_URL}/messages/${lastWebhookMessageId}`;
            method = 'PATCH';
        } else {
            // Append wait=true so Discord returns the message object with its ID
            url = `${WEBHOOK_URL}?wait=true`;
        }
        
        const response = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            if (isEdit && response.status === 404) {
                // If message was deleted by user, reset token and post a new one
                console.warn("⚠️ Webhook message to edit was deleted. Posting a new one...");
                lastWebhookMessageId = null;
                return await sendWebhookMessage(payload, false);
            }
            console.error(`❌ Webhook error: ${response.status} ${response.statusText}`);
            return null;
        }
        
        const responseData = await response.json();
        if (responseData && responseData.id) {
            lastWebhookMessageId = responseData.id;
            await saveWebhookMessageIdToDb(responseData.id);
        }
        return responseData;
    } catch (e) {
        console.error(`❌ Failed to send/edit webhook:`, e.message);
        return null;
    }
}

async function sendPeriodicStatusWebhook() {
    if (!lavalinkManager || !lavalinkManager.nodeManager) return;
    const nodes = Array.from(lavalinkManager.nodeManager.nodes.values());
    const connectedNodes = nodes.filter(node => node && node.connected === true);
    
    const embed = {
        title: "📊 NodeLink Cluster Status Report",
        description: `**Uptime:** \`${formatUptime(Date.now() - startTime)}\`\n**Active Players:** \`${connectedNodes.reduce((sum, n) => sum + (n.stats?.players || 0), 0)}\`\n**Nodes:** \`${connectedNodes.length} / ${nodes.length} Online\``,
        color: connectedNodes.length === nodes.length ? 0x10b981 : (connectedNodes.length > 0 ? 0xf59e0b : 0xef4444),
        fields: nodes.map((node, index) => {
            const nodeName = `${node.options.id || `Node ${index + 1}`}`;
            const pingVal = (node.connected && typeof node.heartBeatPing === 'number' && node.heartBeatPing >= 0) ? `${node.heartBeatPing.toFixed(1)}ms` : 'N/A';
            
            if (!node.connected) {
                return {
                    name: `🔴 ${nodeName}`,
                    value: `\`\`\`diff\n- Disconnected\n\`\`\``,
                    inline: true
                };
            }
            const stats = node.stats || {};
            const cpu = stats.cpu ? `${formatCpuPercent(stats).toFixed(1)}%` : 'N/A';
            const usedRam = stats.memory?.used ? `${(stats.memory.used / 1024 / 1024).toFixed(0)} MB` : 'N/A';
            
            return {
                name: `🟢 ${nodeName}`,
                value: `**Players:** \`${stats.players || 0}\`\n**CPU:** \`${cpu}\`\n**RAM:** \`${usedRam}\`\n**Ping:** \`${pingVal}\``,
                inline: true
            };
        }),
        timestamp: new Date().toISOString(),
        footer: { text: "NodeLink Keeper System" }
    };

    // Send and edit the same message to avoid channel spamming
    await sendWebhookMessage({ embeds: [embed] }, true);
}

async function handleNodeStatusChange(node, isOnline, reason = "") {
    if (!isFullyBooted) return;
    
    const title = isOnline ? "🟢 Node Reconnected" : "🔴 Node Disconnected";
    
    const description = isOnline 
        ? `**Node ID:** \`${node.options.id}\` has successfully connected back to the cluster.`
        : `**Node ID:** \`${node.options.id}\` has lost connection to the cluster.\n${reason ? `**Reason:** \`${reason}\`` : ''}`;
    
    const embed = {
        title,
        description,
        color: isOnline ? 0x10b981 : 0xef4444,
        timestamp: new Date().toISOString(),
        footer: { text: "NodeLink Keeper • Real-time Alert" }
    };

    await sendWebhookMessage({ embeds: [embed] }, false); // Alerts are sent as new messages
}

// Startup Flow
(async () => {
    // 1. Load nodes from database or env fallback
    try {
        myNodes = await getNodesFromSupabase();
        if (!myNodes || myNodes.length === 0) {
            console.log("ℹ️ No nodes found in Supabase or Supabase not configured. Falling back to env...");
            myNodes = buildNodesFromEnv();
        } else {
            console.log(`ℹ️ Successfully loaded ${myNodes.length} nodes from Supabase.`);
        }
    } catch (err) {
        console.error("⚠️ Failed to load nodes at startup:", err.message);
        myNodes = buildNodesFromEnv();
    }

    // 2. Setup Lavalink Manager
    lavalinkManager = new LavalinkManager({
        nodes: myNodes,
        sendToShard: (guildId, payload) => {
            const guild = client.guilds.cache.get(guildId);
            if (guild) guild.shard.send(payload);
        },
        client: {
            id: process.env.CLIENT_ID,
            username: "NodeLink Keeper"
        }
    });

    // 3. Set up event listeners
    lavalinkManager.nodeManager.on('connect', (node) => {
        console.log(`🟢 [Lavalink] Connected to node: ${node.options.id}`);
        handleNodeStatusChange(node, true);
    });

    lavalinkManager.nodeManager.on('disconnect', (node, reason) => {
        console.log(`🔴 [Lavalink] Disconnected from node: ${node.options.id}. Reason:`, reason || "No reason given");
        handleNodeStatusChange(node, false, reason);
    });

    lavalinkManager.nodeManager.on('error', (node, error) => {
        console.error(`⚠️ [Lavalink] Node ${node.options.id} error:`, error.message);
    });

    // Load last webhook message ID from Supabase (to avoid spamming)
    await loadWebhookMessageIdFromDb();

    // 4. Start Discord client
    client.login(process.env.DISCORD_TOKEN);
})();

client.on('ready', async () => {
    console.log(`✅ Bot ${client.user.tag} is online (internal)!`);
    updatePresence();
    
    await lavalinkManager.init({ ...client.user });
    console.log(`🎵 Connecting to ${myNodes.length} NodeLink node(s)...`);
    
    // Run Supabase keepalive immediately on startup
    await runSupabaseKeepAlive();
    
    // Set fully booted after 15s grace period
    setTimeout(async () => {
        isFullyBooted = true;
        console.log("ℹ️ Startup grace period finished. Real-time alerts activated.");
        // Send initial cluster report on boot
        await sendPeriodicStatusWebhook();
    }, 15000);

    // Keep-alive NodeLink — vẫn giữ 60s để tránh node bị Render sleep
    setInterval(async () => {
        if (!lavalinkManager || !lavalinkManager.nodeManager) return;
        const nodes = Array.from(lavalinkManager.nodeManager.nodes.values());
        for (const node of nodes) {
            if (!node || node.connected !== true) continue;
            const randomUrl = youtubeUrls[Math.floor(Math.random() * youtubeUrls.length)];
            try {
                await node.rest.loadTracks(randomUrl);
                console.log(`✅ [${node.options.id}] Kept alive: ${randomUrl}`);
            } catch (e) {
                console.error(`❌ [${node.options.id}] Error:`, e.message);
            }
        }
    }, KEEPALIVE_INTERVAL);

    // Auto-update status messages & presence — mỗi 5 giây
    setInterval(async () => {
        updatePresence();
        for (const [msgId, entry] of statusMessages) {
            try {
                await entry.message.edit({
                    embeds: [getStatusEmbed(entry.lang)],
                    components: [getControlRow(entry.lang)]
                });
                console.log(`🔄 Auto-updated status message: ${msgId}`);
            } catch (e) {
                console.warn(`⚠️ Removed stale status message: ${msgId}`);
                statusMessages.delete(msgId);
            }
        }
    }, REFRESH_INTERVAL);

    // Periodic webhook reports (every 5 seconds)
    setInterval(async () => {
        if (isFullyBooted) {
            console.log("🔄 Sending periodic cluster status webhook...");
            await sendPeriodicStatusWebhook();
        }
    }, WEBHOOK_REPORT_INTERVAL);

    // Periodic database node sync (every 5 minutes)
    setInterval(async () => {
        if (isFullyBooted) {
            console.log("🔄 Checking database for node updates...");
            await syncNodesWithDb();
        }
    }, 5 * 60 * 1000);

    // Run Supabase keepalive every 12 hours
    setInterval(async () => {
        await runSupabaseKeepAlive();
    }, 12 * 60 * 60 * 1000);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) {
        if (interaction.isChatInputCommand() && interaction.commandName === 'status') {
            const reply = await interaction.reply({
                embeds: [getStatusEmbed('en')],
                components: [getControlRow('en')],
                fetchReply: true
            });
            statusMessages.set(reply.id, { message: reply, lang: 'en' });
        }
        return;
    }
    const msgId = interaction.message.id;
    // Đổi ngôn ngữ
    if (['lang_en', 'lang_vi'].includes(interaction.customId)) {
        const lang = interaction.customId === 'lang_en' ? 'en' : 'vi';
        if (statusMessages.has(msgId)) {
            statusMessages.get(msgId).lang = lang;
        }
        await interaction.update({
            embeds: [getStatusEmbed(lang)],
            components: [getControlRow(lang)]
        });
        return;
    }
    // ✅ Refresh thủ công
    if (interaction.customId === 'refresh_status') {
        const lang = statusMessages.get(msgId)?.lang || 'en';
        await interaction.update({
            embeds: [getStatusEmbed(lang)],
            components: [getControlRow(lang)]
        });
        return;
    }
});

client.on('guildCreate', async (guild) => {
    await guild.commands.set([{
        name: 'status',
        description: 'Check NodeLink cluster status / Kiểm tra trạng thái NodeLink'
    }]);
});

client.on('raw', (d) => {
    if (lavalinkManager) lavalinkManager.sendRawData(d);
});
