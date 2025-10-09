require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');
const { google } = require('googleapis');

// Global Error Handlers
process.on('uncaughtException', (e, o) => { console.error('----- Uncaught exception -----', e, o); });
process.on('unhandledRejection', (r, p) => { console.error('----- Unhandled Rejection -----', r, p); });

// Encryption
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY is not set.");
const encrypt = (text) => CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
const decrypt = (ciphertext) => CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8);

// Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

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

console.log('Redirect URI being used:', oauth2Client._opts.redirectUri);

// --- Helper Functions ---
async function getGmailClient() {
    const { data } = await supabase.from('secure_settings').select('value').eq('key', 'google_refresh_token_team').single();
    if (!data || !data.value) throw new Error('Gmail not connected for the team.');
    const refreshToken = decrypt(data.value);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function getPageContentAndMeta(url) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const $ = cheerio.load(body);
                    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                    const foundEmails = body.match(emailRegex);
                    const firstEmail = foundEmails ? foundEmails[0] : null;
                    const metadata = {
                        title: $('title').text(),
                        description: $('meta[name="description"]').attr('content') || '',
                        imageUrl: $('meta[property="og:image"]').attr('content') || '',
                        contactEmail: firstEmail,
                    };
                    resolve({ html: body, metadata });
                } else {
                    reject(new Error(`Request failed with status ${res.statusCode}`));
                }
            });
        });
        request.on('error', (e) => reject(e));
        request.end();
    });
}

const ANALYSIS_PROMPT = `Act as a senior design consultant for \"Minimind Agency\", a creative agency specializing in branding, marketing, and web design. Your tone is professional, friendly, and helpful. You are analyzing the following HTML content from a business's Facebook page. Analyze the HTML and text for branding, marketing, and technical issues from a design agency's perspective. Specifically look for: 1.  **Branding & Content:** Is there a clear 'About Us' section? Is the language professional? Are there spelling/grammar errors? Is there a consistent brand message? 2.  **Marketing & CTA:** Is there a clear Call-to-Action (e.g., \"Send Message\", \"Shop Now\")? Is contact information (email, phone) easily found? 3.  **Technical SEO:** Are important meta tags for sharing (like og:title, og:description, og:image) present in the HTML <head>? Is there a link to an external website? Is it mobile-friendly (look for viewport meta tag)? Based on your analysis, you MUST return ONLY a single, minified JSON object. Do not include any text or formatting before or after the JSON object. The JSON object must have the following structure: {\"overall_score\": <an integer score from 0-100 based on the severity and number of issues found>},\"issues\": [ { \"type\": \"Branding\" | \"Marketing\" | \"Content Quality\" | \"Technical SEO\", \"severity\": \"High\" | \"Medium\" | \"Low\", \"description\": \"A concise description of a specific issue found.\" } ],\"suggestions\": [ { \"title\": \"A short, catchy title for a proposal point.\", \"description\": \"A one-sentence description of a service Minimind Agency can offer to fix an issue. Frame it as a solution.\" } ],\"rationale\": \"A 1-2 sentence, human-readable explanation for the score and decision, from the perspective of the AI agent.\" }`;

function createApiRequest(provider, apiKey, promptContent, type = 'analyze') {
    let prompt;
    let response_format = { "type": "text" };
    if (type === 'analyze' || type === 'proposal') {
        response_format = { "type": "json_object" };
    }
    if (type === 'analyze') {
        prompt = ANALYSIS_PROMPT + ` Here is the HTML content for page ${promptContent.pageName}: --- ${promptContent.content.substring(0, 30000)} ---`;
    } else {
        prompt = promptContent;
    }
    if (!prompt) throw new Error("Prompt could not be generated for the AI request.");

    let url, postData, headers;
    switch (provider) {
        case 'gemini':
            url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
            headers = { 'Content-Type': 'application/json' };
            let geminiPayload = { contents: [{ parts: [{ text: prompt }] }] };
            if (response_format.type === 'json_object') {
                geminiPayload.generationConfig = { response_mime_type: "application/json" };
            }
            postData = JSON.stringify(geminiPayload);
            break;
        default:
            throw new Error('Invalid provider');
    }

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'POST', headers, timeout: 120000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${provider} API failed with status ${res.statusCode}: ${body}`));
                    const responseData = JSON.parse(body);
                    const rawJson = responseData.candidates[0].content.parts[0].text;
                    if (response_format.type === 'json_object') {
                         const jsonMatch = rawJson.match(/\{.*\}/s);
                        if (!jsonMatch) throw new Error("AI returned non-JSON response.");
                        resolve(JSON.parse(jsonMatch[0]));
                    } else {
                        resolve(rawJson);
                    }
                } catch (e) {
                    reject(new Error(`${provider} response parse error: ${e.message}. Raw: ${body}`));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// --- Endpoints ---
app.get('/test', (req, res) => res.status(200).json({ message: "Backend is alive!" }));

// Auth
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

app.post('/auth/google/watch', async (req, res) => {
    try {
        const gmail = await getGmailClient();
        const response = await gmail.users.watch({
            userId: 'me',
            requestBody: {
                topicName: process.env.GOOGLE_PUB_SUB_TOPIC,
                labelIds: ['INBOX']
            }
        });
        res.status(200).json(response.data);
    } catch (error) {
        console.error('Error setting up Gmail watch:', error);
        res.status(500).json({ error: error.message });
    }
});

// Analyze
app.post('/analyze', async (req, res) => {
    try {
        const { pageUrl, pageName } = req.body;
        const { html: htmlContent, metadata } = await getPageContentAndMeta(pageUrl);
        const provider = process.env.API_PROVIDER?.toLowerCase();
        const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
        const analysisResult = await createApiRequest(provider, apiKey, { content: htmlContent, pageName }, 'analyze');
        res.status(200).json({ ...analysisResult, metadata });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Drafts & Proposals
app.post('/create-proposal', async (req, res) => {
    const { analysisId, userId } = req.body;
    try {
        const { data: analysis } = await supabase.from('analyses').select(`*, pages (*)`).eq('id', analysisId).single();
        if (!analysis) throw new Error("Analysis not found");
        const page = analysis.pages;
        let prompt = ANALYSIS_PROMPT.replace('{pageName}', page.name).replace('{overall_score}', analysis.overall_score).replace('{issues}', JSON.stringify(analysis.issues.map(i => i.description))).replace('{rationale}', analysis.rationale);
        const provider = process.env.API_PROVIDER?.toLowerCase();
        const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
        const aiResult = await createApiRequest(provider, apiKey, prompt, 'proposal');
        const { data: newDraft } = await supabase.from('drafts').insert({ page_id: page.id, analysis_id: analysis.id, created_by: userId, fb_message: aiResult.facebook_message, email_subject: aiResult.email_subject, email_body: aiResult.email_body, status: 'pending' }).select().single();
        res.status(201).json(newDraft);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/drafts/custom', async (req, res) => {
    const { userId, mode, pageName, pageUrl, contactEmail, aiNotes, fbMessage, emailSubject, emailBody } = req.body;
    try {
        const { data: page } = await supabase.from('pages').upsert({ url: pageUrl, name: pageName, contact_email: contactEmail, created_by: userId }, { onConflict: 'url' }).select().single();
        if (!page) throw new Error("Failed to upsert page");
        let finalFbMessage = fbMessage, finalEmailSubject = emailSubject, finalEmailBody = emailBody;
        if (mode === 'ai') {
            const aiPrompt = `Act as a design consultant. Based on these notes: "${aiNotes}", write a short Facebook message and a professional email proposal for the page "${pageName}". Return ONLY a minified JSON object: {"facebook_message": "...", "email_subject": "...", "email_body": "..."}`;
            const provider = process.env.API_PROVIDER?.toLowerCase();
            const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
            const aiResult = await createApiRequest(provider, apiKey, aiPrompt, 'proposal');
            finalFbMessage = aiResult.facebook_message;
            finalEmailSubject = aiResult.email_subject;
            finalEmailBody = aiResult.email_body;
        }
        const { data: newDraft } = await supabase.from('drafts').insert({ page_id: page.id, created_by: userId, fb_message: finalFbMessage, email_subject: finalEmailSubject, email_body: finalEmailBody, status: 'pending' }).select().single();
        res.status(201).json(newDraft);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/drafts/:id/send', async (req, res) => {
    const { id: draftId } = req.params;
    const { userId } = req.body; // userId is still used to log the sender
    try {
        const gmail = await getGmailClient();
        const { data: draft } = await supabase.from('drafts').select('*, pages(*)').eq('id', draftId).single();
        if (!draft) throw new Error("Draft not found.");
        let messageId = null;
        if (draft.send_to_email) {
            const emailLines = [`To: ${draft.pages.contact_email}`, `Subject: ${draft.email_subject}`, 'Content-type: text/html;charset=iso-8859-1', 'MIME-Version: 1.0', '', draft.email_body.replace(/\n/g, '<br>')];
            const rawEmail = Buffer.from(emailLines.join('\r\n')).toString('base64');
            const sentEmail = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawEmail } });
            messageId = sentEmail.data.id;
        }
        // TODO: Facebook send logic
        await supabase.from('messages').insert({ draft_id: draft.id, page_id: draft.page_id, platform: 'email', status: 'sent', sent_by: userId, provider_message_id: messageId });
        await supabase.rpc('update_draft_status_as_service_role', { draft_id_in: draft.id, new_status: 'sent' });
        res.status(200).json({ message: "Message sent successfully." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Campaigns
app.post('/campaigns/:id/send-all', async (req, res) => { /* ... */ });

// Conversations
app.post('/replies/send', async (req, res) => {
    const { userId, pageId, content } = req.body;
    try {
        const gmail = await getGmailClient();
        const { data: page } = await supabase.from('pages').select('contact_email, name').eq('id', pageId).single();
        if (!page) throw new Error("Page not found.");

        const subject = `Re: Your inquiry about ${page.name}`;
        const emailLines = [
            `To: ${page.contact_email}`,
            `Subject: ${subject}`,
            'Content-Type: text/html; charset=utf-8',
            'MIME-Version: 1.0',
            '',
            content.replace(/\n/g, '<br>')
        ];
        const rawEmail = Buffer.from(emailLines.join('\r\n')).toString('base64');
        const sentEmail = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawEmail } });

        await supabase.from('replies').insert({
            page_id: pageId,
            content: content,
            platform: 'email',
            is_reply: true, // This is an outgoing reply from an agent
            sent_by: userId,
            provider_message_id: sentEmail.data.id
        });

        res.status(200).json({ message: "Reply sent successfully." });
    } catch (error) {
        console.error('Error sending reply:', error);
        res.status(500).json({ error: error.message });
    }
});
app.delete('/conversations/:pageId', async (req, res) => { /* ... */ });

const mailparser = require('mailparser');

// ... (keep existing code until the webhook)

// Google Webhook for replies
app.post('/google/webhook', async (req, res) => {
    console.log('Received Google Webhook Notification:');
    try {
        const message = req.body.message;
        if (!message || !message.data) {
            console.log('Invalid webhook payload');
            return res.status(400).send('Invalid payload');
        }

        const decodedData = Buffer.from(message.data, 'base64').toString('utf-8');
        const data = JSON.parse(decodedData);
        const { emailAddress, historyId } = data;

        console.log(`Processing notification for team account ${emailAddress} with historyId ${historyId}`);

        // Get last history ID for the team
        const { data: historySetting } = await supabase
            .from('secure_settings')
            .select('value')
            .eq('key', 'google_history_id_team')
            .single();

        const startHistoryId = historySetting ? decrypt(historySetting.value) : null;
        if (!startHistoryId) {
            console.log(`No startHistoryId for team, setting it for the first time.`);
            await supabase.from('secure_settings').upsert({ key: 'google_history_id_team', value: encrypt(String(historyId)) }, { onConflict: 'key' });
            return res.status(204).send();
        }

        const gmail = await getGmailClient();
        const historyResponse = await gmail.users.history.list({
            userId: 'me',
            startHistoryId: startHistoryId,
        });

        const history = historyResponse.data.history;
        if (history && history.length > 0) {
            for (const item of history) {
                if (item.messagesAdded) {
                    for (const msg of item.messagesAdded) {
                        if (msg.message.labelIds.includes('UNREAD') && !msg.message.labelIds.includes('SENT')) {
                            const messageDetails = await gmail.users.messages.get({ userId: 'me', id: msg.message.id, format: 'raw' });
                            const rawEmail = Buffer.from(messageDetails.data.raw, 'base64').toString('utf-8');
                            
                            const parsed = await mailparser.simpleParser(rawEmail);

                            const inReplyTo = parsed.inReplyTo;
                            let pageId = null;

                            if (inReplyTo) {
                                const { data: originalMessage } = await supabase
                                    .from('messages')
                                    .select('page_id')
                                    .eq('provider_message_id', inReplyTo.replace(/[<>]/g, ''))
                                    .single();
                                if (originalMessage) {
                                    pageId = originalMessage.page_id;
                                }
                            }

                            if (!pageId && parsed.from.value && parsed.from.value.length > 0) {
                                const senderEmail = parsed.from.value[0].address;
                                const { data: page } = await supabase
                                    .from('pages')
                                    .select('id')
                                    .eq('contact_email', senderEmail)
                                    .single();
                                if (page) {
                                    pageId = page.id;
                                }
                            }

                            if (pageId) {
                                await supabase.from('replies').insert({
                                    content: parsed.text,
                                    platform: 'email',
                                    received_at: parsed.date,
                                    is_reply: false, // This is an incoming message
                                    page_id: pageId,
                                    sender: parsed.from.text,
                                });
                                console.log(`Processed and stored new message: ${parsed.subject}`);
                            } else {
                                console.log(`Could not determine page_id for message: ${parsed.subject}`);
                            }
                        }
                    }
                }
            }
        }

        // Update history ID
        await supabase.from('secure_settings').upsert({ key: 'google_history_id_team', value: encrypt(String(historyId)) }, { onConflict: 'key' });

        res.status(204).send();
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).send('Error processing webhook');
    }
});

app.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});