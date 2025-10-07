require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');
const nodemailer = require('nodemailer');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY is not set in environment variables.");
}

// Helper functions for encryption and decryption
const encrypt = (text) => {
    return CryptoJS.AES.encrypt(text, ENCRYPTION_KEY).toString();
};

const decrypt = (ciphertext) => {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
};


const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- 1. SCRAPING FUNCTION ---
async function getPageContentAndMeta(url) {
    console.log(`Fetching content via Bright Data Proxy for URL: ${url}`);
    const connectionString = process.env.BRIGHTDATA_CONNECTION_STRING;
    if (!connectionString || connectionString.includes("username:password")) throw new Error("BRIGHTDATA_CONNECTION_STRING is not set correctly.");

    const [userPass, hostPort] = connectionString.split('@');
    const [username, password] = userPass.split(':');
    const [host, port] = hostPort.split(':');

    return new Promise((resolve, reject) => {
        const options = { host, port: parseInt(port, 10), path: url, headers: { 'Proxy-Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'), 'Host': new URL(url).hostname } };
        const request = http.get(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const $ = cheerio.load(body);

                    // Simple regex to find email addresses
                    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                    const foundEmails = body.match(emailRegex);
                    const firstEmail = foundEmails ? foundEmails[0] : null;

                    const metadata = {
                        title: $('meta[property="og:title"]').attr('content') || $('title').text(),
                        description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '',
                        imageUrl: $('meta[property="og:image"]').attr('content') || '',
                        contactEmail: firstEmail,
                    };
                    console.log("Extracted Metadata:", metadata);
                    resolve({ html: body, metadata });
                } else {
                    reject(new Error(`Request failed: ${res.statusCode} ${body}`))
                }
            });
        });
        request.on('error', (e) => reject(e));
        request.end();
    });
}

const ANALYSIS_PROMPT = `Act as a senior design consultant for \"Minimind Agency\", a creative agency specializing in branding, marketing, and web design. Your tone is professional, friendly, and helpful. You are analyzing the following HTML content from a business's Facebook page. Analyze the HTML and text for branding, marketing, and technical issues from a design agency's perspective. Specifically look for: 1.  **Branding & Content:** Is there a clear 'About Us' section? Is the language professional? Are there spelling/grammar errors? Is there a consistent brand message? 2.  **Marketing & CTA:** Is there a clear Call-to-Action (e.g., \"Send Message\", \"Shop Now\")? Is contact information (email, phone) easily found? 3.  **Technical SEO:** Are important meta tags for sharing (like og:title, og:description, og:image) present in the HTML <head>? Is there a link to an external website? Is it mobile-friendly (look for viewport meta tag)? Based on your analysis, you MUST return ONLY a single, minified JSON object. Do not include any text or formatting before or after the JSON object. The JSON object must have the following structure: {\"overall_score\": <an integer score from 0-100 based on the severity and number of issues found>},\"issues\": [ { \"type\": \"Branding\" | \"Marketing\" | \"Content Quality\" | \"Technical SEO\", \"severity\": \"High\" | \"Medium\" | \"Low\", \"description\": \"A concise description of a specific issue found.\" } ],\"suggestions\": [ { \"title\": \"A short, catchy title for a proposal point.\", \"description\": \"A one-sentence description of a service Minimind Agency can offer to fix an issue. Frame it as a solution.\" } ],\"rationale\": \"A 1-2 sentence, human-readable explanation for the score and decision, from the perspective of the AI agent.\" }`;

// --- 2. DYNAMIC AI ANALYSIS FUNCTION ---
function createApiRequest(provider, apiKey, promptContent, type = 'analyze') {
    let prompt, response_format, model;
    if (type === 'analyze') {
        prompt = ANALYSIS_PROMPT + ` Here is the HTML content for page ${promptContent.pageName}: --- ${promptContent.content.substring(0, 30000)} ---`;
        response_format = { "type": "json_object" };
    } else {
        prompt = promptContent;
        response_format = { "type": "text" };
    }

    let url, postData, headers;

    switch (provider) {
        case 'openai':
            url = 'https://api.openai.com/v1/chat/completions';
            headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
            model = "gpt-3.5-turbo";
            postData = JSON.stringify({ model, response_format, messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: prompt }] });
            break;
        case 'gemini':
            url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
            headers = { 'Content-Type': 'application/json' };
            if (type === 'analyze' || type === 'proposal') {
                postData = JSON.stringify({ 
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        response_mime_type: "application/json",
                    }
                });
            } else {
                postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
            }
            break;
        case 'deepseek':
            url = 'https://api.deepseek.com/v1/chat/completions';
            headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
            model = "deepseek-chat";
            postData = JSON.stringify({ model, response_format, messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: prompt }] });
            break;
        case 'claude':
            url = 'https://api.anthropic.com/v1/messages';
            headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
            model = "claude-3-sonnet-20240229";
            postData = JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] });
            break;
        default: throw new Error('Invalid provider');
    }

    return new Promise((resolve, reject) => {
        const req = https.request(url, { method: 'POST', headers, timeout: 120000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${provider} API failed with status ${res.statusCode}: ${body}`));
                    const responseData = JSON.parse(body);
                    let rawJson;
                    if (provider === 'claude') rawJson = responseData.content[0].text;
                    else if (provider === 'gemini') rawJson = responseData.candidates[0].content.parts[0].text;
                    else rawJson = responseData.choices[0].message.content;
                    
                    if (type === 'analyze') {
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
        req.on('timeout', () => { req.abort(); reject(new Error(`${provider} API request timed out.`)); });
        req.on('error', (e) => reject(e));
        req.write(postData);
        req.end();
    });
}

// --- 3. MAIN API ENDPOINTS ---
app.post('/analyze', async (req, res) => {
    const { pageUrl, pageName } = req.body;
    if (!pageUrl || !pageName) return res.status(400).json({ error: 'pageUrl and pageName are required.' });

    try {
        const { html: htmlContent, metadata } = await getPageContentAndMeta(pageUrl);
        const provider = process.env.API_PROVIDER?.toLowerCase();
        const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
        if (!apiKey || apiKey.includes('Your-')) throw new Error(`API key for '${provider}' is not set correctly.`);

        console.log(`Using AI Provider: ${provider} for analysis`);
        const analysisResult = await createApiRequest(provider, apiKey, { content: htmlContent, pageName: pageName }, 'analyze');
        
        res.status(200).json({ ...analysisResult, metadata });

    } catch (error) {
        console.error("Error in /analyze endpoint:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/chat', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });

    try {
        const provider = process.env.API_PROVIDER?.toLowerCase();
        const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
        if (!apiKey || apiKey.includes('Your-')) throw new Error(`API key for '${provider}' is not set.`);

        console.log(`Using AI Provider: ${provider} for chat`);
        const chatResult = await createApiRequest(provider, apiKey, prompt, 'chat');
        res.status(200).json({ reply: chatResult });

    } catch (error) {
        console.error("Error in /chat endpoint:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const PROPOSAL_PROMPT_TEMPLATE = `
Act as a friendly and professional design consultant from "Minimind Agency". Your goal is to write a personalized and compelling outreach message based on an analysis of a potential client's Facebook page.

**Analysis Details:**
- Page Name: {pageName}
- Overall Design Score: {overall_score}/100
- Key Issues Found: {issues}
- AI Rationale: {rationale}

**Your Task:**
Generate two versions of an outreach message: a short, friendly Facebook message and a slightly more detailed professional email. The tone should be helpful, not spammy. Reference one or two key issues from the analysis as a conversation starter.

**Output Format:**
You MUST return ONLY a single, minified JSON object with the following structure: {"facebook_message": "<Your generated Facebook message>", "email_subject": "<Your generated email subject>", "email_body": "<Your generated email body>"}

**Example Snippets (for tone and style):
- Facebook: "Hi {pageName}, I checked your page and noticed some design inconsistencies that might be affecting engagement. I can share a free concept for you to review — no obligations. Interested?"
- Email Subject: "Design refresh proposal for {pageName}"
- Email Body: "Hello, I’m from Minimind Agency. We reviewed your Facebook page and see opportunities to improve clarity through consistent branding..."

Now, generate the JSON for the page mentioned above.
`;

app.post('/create-proposal', async (req, res) => {
    const { analysisId, userId } = req.body;
    if (!analysisId || !userId) return res.status(400).json({ error: 'analysisId and userId are required.' });

    try {
        // 1. Fetch analysis and page data from Supabase
        const { data: analysis, error: analysisError } = await supabase
            .from('analyses')
            .select(`
                *,
                pages (*)
            `)
            .eq('id', analysisId)
            .single();

        if (analysisError) throw new Error(`Failed to fetch analysis: ${analysisError.message}`);
        if (!analysis) return res.status(404).json({ error: 'Analysis not found.' });

        const page = analysis.pages;

        // 2. Construct the prompt for the AI
        let prompt = PROPOSAL_PROMPT_TEMPLATE
            .replace('{pageName}', page.name)
            .replace('{overall_score}', analysis.overall_score)
            .replace('{issues}', JSON.stringify(analysis.issues.map(i => i.description)))
            .replace('{rationale}', analysis.rationale);

        // 3. Call the AI to generate the proposal
        const provider = process.env.API_PROVIDER?.toLowerCase();
        const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
        const aiResultRaw = await createApiRequest(provider, apiKey, prompt, 'proposal');
        
        const jsonMatch = aiResultRaw.match(/\{.*\}/s);
        if (!jsonMatch) throw new Error("AI returned non-JSON response for proposal.");
        const proposalContent = JSON.parse(jsonMatch[0]);

        // 4. Save the new draft to the database
        const { data: newDraft, error: draftError } = await supabase
            .from('drafts')
            .insert({
                page_id: page.id,
                analysis_id: analysis.id,
                created_by: userId,
                fb_message: proposalContent.facebook_message,
                email_subject: proposalContent.email_subject,
                email_body: proposalContent.email_body,
                status: 'pending'
            })
            .select()
            .single();

        if (draftError) throw new Error(`Failed to save draft: ${draftError.message}`);

        res.status(201).json(newDraft);

    } catch (error) {
        console.error("Error in /create-proposal endpoint:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const SEND_INTERVAL_MS = 10000; // 10 seconds between each message

app.post('/campaigns/:id/send-all', async (req, res) => {
    const { id: campaignId } = req.params;
    const { userId, channel } = req.body; // channel can be 'email', 'facebook', or 'both'

    if (!userId || !channel) return res.status(400).json({ error: 'userId and channel are required.' });

    res.status(202).json({ message: "Bulk send process started. Messages will be sent in the background." });

    // Run the sending process in the background
    (async () => {
        try {
            console.log(`Starting bulk send for campaign: ${campaignId} with channel: ${channel}`);

            // First, check if the campaign is active
            const { data: campaign, error: campaignError } = await supabase
                .from('campaigns')
                .select('status')
                .eq('id', campaignId)
                .single();

            if (campaignError) throw new Error(`Failed to fetch campaign status: ${campaignError.message}`);
            if (campaign.status !== 'active') {
                console.log(`Campaign ${campaignId} is not active. Aborting bulk send.`);
                return;
            }

            const { data: drafts, error: draftsError } = await supabase
                .from('drafts')
                .select('*, pages(contact_email)') // Fetch contact_email from related page
                .eq('campaign_id', campaignId)
                .eq('status', 'approved');

            if (draftsError) throw new Error(`Failed to fetch approved drafts: ${draftsError.message}`);
            if (!drafts || drafts.length === 0) {
                console.log("No approved drafts to send for this campaign.");
                return;
            }

            console.log(`Found ${drafts.length} approved drafts to send.`);

            // Fetch SMTP settings once for the campaign
            const { data: settingsData, error: settingsError } = await supabase
                .from('secure_settings')
                .select('key, value')
                .in('key', ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass']);
            
            if (settingsError) {
                console.warn("Could not fetch SMTP settings. Email sending will be skipped.");
            }

            const smtpConfig = settingsData ? settingsData.reduce((acc, setting) => {
                acc[setting.key] = setting.value;
                return acc;
            }, {}) : {};

            for (const draft of drafts) {
                let sent = false;
                if ((channel === 'email' || channel === 'both') && draft.send_to_email && smtpConfig.smtp_pass) {
                    try {
                        const decryptedPass = decrypt(smtpConfig.smtp_pass);
                        const transporter = nodemailer.createTransport({
                            host: smtpConfig.smtp_host,
                            port: parseInt(smtpConfig.smtp_port, 10),
                            secure: parseInt(smtpConfig.smtp_port, 10) === 465,
                            auth: { user: smtpConfig.smtp_user, pass: decryptedPass },
                        });

                        console.log(`Sending email for draft ${draft.id} to ${draft.pages.contact_email}...`);
                        await transporter.sendMail({
                            from: `"Minimind Agency" <${smtpConfig.smtp_user}>`,
                            to: draft.pages.contact_email,
                            subject: draft.email_subject,
                            html: draft.email_body,
                        });
                        sent = true;
                        console.log(`Email sent for draft ${draft.id}`);
                    } catch (emailError) {
                        console.error(`Failed to send email for draft ${draft.id}:`, emailError.message);
                    }
                }

                if ((channel === 'facebook' || channel === 'both') && draft.send_to_facebook) {
                    // TODO: Add Facebook sending logic here
                    console.log(`Simulating Facebook message send for draft ${draft.id}`);
                    sent = true; // Mark as sent for simulation purposes
                }

                if (sent) {
                    const { error: updateError } = await supabase
                        .from('drafts')
                        .update({ status: 'sent', sent_at: new Date().toISOString() })
                        .eq('id', draft.id);
                    if (updateError) console.error(`Failed to update status for draft ${draft.id}:`, updateError.message);
                } else {
                    console.warn(`Draft ${draft.id} was not sent to any channel.`);
                }

                await new Promise(resolve => setTimeout(resolve, SEND_INTERVAL_MS));
            }
            console.log(`Bulk send finished for campaign: ${campaignId}`);
        } catch (error) {
            console.error(`Error during bulk send for campaign ${campaignId}:`, error.message);
        }
    })();
});

app.post('/settings/smtp', async (req, res) => {
    const { userId, host, port, user, pass } = req.body;
    if (!userId || !host || !port || !user || !pass) {
        return res.status(400).json({ error: 'Missing required SMTP settings.' });
    }

    try {
        const settingsToUpsert = [
            { key: 'smtp_host', value: host, updated_by: userId },
            { key: 'smtp_port', value: port.toString(), updated_by: userId },
            { key: 'smtp_user', value: user, updated_by: userId },
            { key: 'smtp_pass', value: encrypt(pass), updated_by: userId }, // Encrypt the password
        ];

        const { error } = await supabase.from('secure_settings').upsert(settingsToUpsert, { onConflict: 'key' });

        if (error) throw new Error(`Failed to save SMTP settings: ${error.message}`);

        res.status(200).json({ message: 'SMTP settings saved successfully.' });

    } catch (error) {
        console.error("Error saving SMTP settings:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/settings/smtp', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('secure_settings')
            .select('key, value')
            .in('key', ['smtp_host', 'smtp_user']);

        if (error) throw error;

        const settings = data.reduce((acc, setting) => {
            acc[setting.key] = setting.value;
            return acc;
        }, {});

        res.status(200).json(settings);
    } catch (error) {
        console.error("Error fetching SMTP status:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/settings/smtp', async (req, res) => {
    try {
        const { error } = await supabase
            .from('secure_settings')
            .delete()
            .in('key', ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass']);

        if (error) throw new Error(`Failed to delete SMTP settings: ${error.message}`);

        res.status(200).json({ message: 'SMTP settings deleted successfully.' });
    } catch (error) {
        console.error("Error deleting SMTP settings:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// --- Facebook Settings Endpoints ---
app.get('/settings/facebook', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('secure_settings')
            .select('key, value')
            .in('key', ['facebook_page_id', 'facebook_page_name']);

        if (error) throw error;

        const settings = data.reduce((acc, setting) => {
            acc[setting.key] = setting.value;
            return acc;
        }, {});

        res.status(200).json(settings);
    } catch (error) {
        console.error("Error fetching Facebook status:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/settings/facebook/connect', async (req, res) => {
    const { userId, accessToken, pageId, pageName } = req.body;
    if (!userId || !accessToken || !pageId || !pageName) {
        return res.status(400).json({ error: 'Missing required Facebook connection data.' });
    }

    try {
        // In a real app, you would exchange the short-lived accessToken for a long-lived one here.
        // For now, we'll just save the provided one (assuming it's already long-lived or handled by frontend).
        const settingsToUpsert = [
            { key: 'facebook_page_id', value: pageId, updated_by: userId },
            { key: 'facebook_page_name', value: pageName, updated_by: userId },
            { key: 'facebook_page_access_token', value: encrypt(accessToken), updated_by: userId },
        ];

        const { error } = await supabase.from('secure_settings').upsert(settingsToUpsert, { onConflict: 'key' });

        if (error) throw new Error(`Failed to save Facebook settings: ${error.message}`);

        res.status(200).json({ message: 'Facebook page connected successfully.' });

    } catch (error) {
        console.error("Error connecting Facebook page:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.delete('/settings/facebook', async (req, res) => {
    try {
        const { error } = await supabase
            .from('secure_settings')
            .delete()
            .in('key', ['facebook_page_id', 'facebook_page_name', 'facebook_page_access_token']);

        if (error) throw new Error(`Failed to delete Facebook settings: ${error.message}`);

        res.status(200).json({ message: 'Facebook settings deleted successfully.' });
    } catch (error) {
        console.error("Error deleting Facebook settings:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.post('/drafts/custom', async (req, res) => {
    const { 
        userId, mode, pageName, pageUrl, contactEmail, 
        aiNotes, fbMessage, emailSubject, emailBody 
    } = req.body;

    if (!userId || !pageName || !pageUrl) {
        return res.status(400).json({ error: 'User, Page Name, and Page URL are required.' });
    }

    try {
        // 1. Upsert the page
        const { data: page, error: pageError } = await supabase
            .from('pages')
            .upsert({ url: pageUrl, name: pageName, contact_email: contactEmail, created_by: userId }, { onConflict: 'url' })
            .select()
            .single();

        if (pageError) throw new Error(`Failed to upsert page: ${pageError.message}`);

        let finalFbMessage = fbMessage;
        let finalEmailSubject = emailSubject;
        let finalEmailBody = emailBody;

        // 2. If AI mode, generate content
        if (mode === 'ai') {
            const aiPrompt = `Act as a design consultant. Based on these notes: "${aiNotes}", write a short Facebook message and a professional email proposal for the page "${pageName}". Return ONLY a minified JSON object: {"facebook_message": "...", "email_subject": "...", "email_body": "..."}`;
            
            const provider = process.env.API_PROVIDER?.toLowerCase();
            const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
            const aiResultRaw = await createApiRequest(provider, apiKey, aiPrompt, 'proposal');
            
            const jsonMatch = aiResultRaw.match(/\{.*\}/s);
            if (!jsonMatch) throw new Error("AI returned non-JSON response.");
            const proposalContent = JSON.parse(jsonMatch[0]);

            finalFbMessage = proposalContent.facebook_message;
            finalEmailSubject = proposalContent.email_subject;
            finalEmailBody = proposalContent.email_body;
        }

        // 3. Save the new draft
        const { data: newDraft, error: draftError } = await supabase
            .from('drafts')
            .insert({
                page_id: page.id,
                created_by: userId,
                fb_message: finalFbMessage,
                email_subject: finalEmailSubject,
                email_body: finalEmailBody,
                status: 'pending'
            })
            .select()
            .single();

        if (draftError) throw new Error(`Failed to save draft: ${draftError.message}`);

        res.status(201).json(newDraft);

    } catch (error) {
        console.error("Error in /drafts/custom endpoint:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});