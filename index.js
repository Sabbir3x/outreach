require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const CryptoJS = require('crypto-js');
const { simpleParser } = require('mailparser');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');

// --- Setup ---
process.on('uncaughtException', (e, o) => { console.error('----- Uncaught exception -----', e, o); });
process.on('unhandledRejection', (r, p) => { console.error('----- Unhandled Rejection -----', r, p); });

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set.");
const encrypt = (text) => CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
const decrypt = (ciphertext) => CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const app = express();
const port = process.env.PORT || 3002;
app.use(cors());
app.use(bodyParser.json());

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BACKEND_URL}/auth/google/callback`
);

// --- Gmail API Helper ---
async function getGmailClient() {
    const { data } = await supabase.from('secure_settings').select('value').eq('key', 'google_refresh_token_team').single();
    if (!data || !data.value) throw new Error('Gmail not connected for the team.');
    const refreshToken = decrypt(data.value);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: 'v1', auth: oauth2Client });
}

// --- Google Auth Endpoints ---
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify'] });
    res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const { tokens } = await oauth2Client.getToken(code);
        if (!tokens.refresh_token) throw new Error("Refresh token not received.");
        oauth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        await supabase.from('secure_settings').upsert([
            { key: 'google_refresh_token_team', value: encrypt(tokens.refresh_token) },
            { key: 'google_user_email_team', value: profile.data.emailAddress }
        ], { onConflict: 'key' });
        res.redirect(`${process.env.FRONTEND_URL}?view=settings&status=google_connected`);
    } catch (error) {
        console.error("Error getting Google token:", error);
        res.redirect(`${process.env.FRONTEND_URL}?view=settings&status=google_failed`);
    }
});

app.get('/auth/google/status', async (req, res) => {
    const { data } = await supabase.from('secure_settings').select('value').eq('key', 'google_user_email_team').single();
    if (data && data.value) res.json({ connected: true, email: data.value });
    else res.json({ connected: false });
});

app.post('/auth/google/disconnect', async (req, res) => {
    await supabase.from('secure_settings').delete().like('key', '%_team');
    res.json({ message: "Disconnected successfully" });
});

// All other endpoints are coming back now!

// --- Main Endpoints ---
app.post('/replies/send', async (req, res) => {
    const { userId, pageId, content } = req.body;
    try {
        const gmail = await getGmailClient();
        const { data: page } = await supabase.from('pages').select('contact_email, name').eq('id', pageId).single();
        if (!page) throw new Error("Page not found.");

        const { data: lastMessage } = await supabase.from('messages').select('provider_message_id').eq('page_id', pageId).order('sent_at', { ascending: false }).limit(1).single();
        if (!lastMessage) throw new Error("Original message thread not found.");

        const message = await gmail.users.messages.get({ userId: 'me', id: lastMessage.provider_message_id });
        const subjectHeader = message.data.payload.headers.find(h => h.name === 'Subject');
        const subject = subjectHeader ? subjectHeader.value : `Re: Your conversation with ${page.name}`;
        const threadId = message.data.threadId;

        const emailLines = [
            `To: ${page.contact_email}`,
            `Subject: ${subject}`,
            'Content-Type: text/html; charset=utf-8',
            'MIME-Version: 1.0',
            '',
            content.replace(/\n/g, '<br>')
        ];
        const rawEmail = Buffer.from(emailLines.join('\r\n')).toString('base64');
        const sentEmail = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawEmail, threadId } });

        await supabase.from('replies').insert({ message_id: lastMessage.id, page_id: pageId, content, platform: 'email', is_reply: true, sent_by: userId, provider_message_id: sentEmail.data.id });
        res.status(200).json({ message: "Reply sent successfully." });
    } catch (error) {
        console.error('Error sending reply:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- Gmail Listener ---
function getPart(parts, mimeType) {
    for (const part of parts) {
        if (part.mimeType === mimeType && part.body && part.body.data) return Buffer.from(part.body.data, 'base64').toString('utf-8');
        if (part.parts) {
            const result = getPart(part.parts, mimeType);
            if (result) return result;
        }
    }
    return '';
}

async function processGmailHistory(history) {
    const gmail = await getGmailClient();
    for (const item of history) {
        if (item.messagesAdded) {
            for (const msg of item.messagesAdded) {
                if (msg.message.labelIds.includes('INBOX')) {
                    const messageDetails = await gmail.users.messages.get({ userId: 'me', id: msg.message.id });
                    const fromHeader = messageDetails.data.payload.headers.find(h => h.name === 'From').value;
                    const fromEmail = fromHeader.match(/<(.+)>/)[1];
                    const { data: pageData } = await supabase.from('pages').select('id').eq('contact_email', fromEmail).single();
                    if (pageData) {
                        let body = getPart(messageDetails.data.payload.parts, 'text/plain');
                        if (!body) body = getPart(messageDetails.data.payload.parts, 'text/html');
                        const replyContent = body.split(/\r?\nOn.*wrote:/)[0].trim();
                        if (replyContent) {
                            const { data: originalMessage } = await supabase.from('messages').select('id').eq('page_id', pageData.id).order('sent_at', {ascending: false}).limit(1).single();
                            if (originalMessage) {
                                await supabase.from('replies').insert({ message_id: originalMessage.id, page_id: pageData.id, content: replyContent, is_reply: false, platform: 'email' });
                                console.log(`Saved new reply from ${fromEmail}`);
                                await gmail.users.messages.modify({ userId: 'me', id: msg.message.id, requestBody: { removeLabelIds: ['UNREAD'] } });
                            }
                        }
                    }
                }
            }
        }
    }
}

async function startGmailListener() {
    console.log("Gmail Listener starting...");
    try {
        const gmail = await getGmailClient();
        const { data: historySetting } = await supabase.from('secure_settings').select('value').eq('key', 'google_history_id_team').single();
        let startHistoryId = historySetting ? decrypt(historySetting.value) : null;

        if (!startHistoryId) {
            const profile = await gmail.users.getProfile({ userId: 'me' });
            startHistoryId = profile.data.historyId;
        }

        setInterval(async () => {
            try {
                const response = await gmail.users.history.list({ userId: 'me', startHistoryId });
                if (response.data.history) {
                    await processGmailHistory(response.data.history);
                }
                startHistoryId = response.data.historyId;
                await supabase.from('secure_settings').upsert({ key: 'google_history_id_team', value: encrypt(startHistoryId) }, { onConflict: 'key' });
            } catch (e) { console.error("Error during Gmail poll:", e.message); }
        }, 60000);
    } catch (e) { console.error("Could not start Gmail listener:", e.message); }
}

app.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
    startGmailListener();
});
