require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const { google } = require('googleapis');
const CryptoJS = require('crypto-js');

// Global Error Handlers
process.on('uncaughtException', (e, o) => { console.error('----- Uncaught exception -----', e, o); });
process.on('unhandledRejection', (r, p) => { console.error('----- Unhandled Rejection -----', r, p); });

// Encryption
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set.");
const encrypt = (text) => CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
const decrypt = (ciphertext) => CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8);

// Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Express App
const app = express();
const port = process.env.PORT || 3002;
app.use(cors());
app.use(bodyParser.json());

// Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BACKEND_URL}/auth/google/callback`
);

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

// All other endpoints are removed for now to focus on fixing the auth flow.
// They will be added back once this is confirmed to be working.

app.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});