require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- 1. SCRAPING FUNCTION (using Bright Data) ---
async function getPageContent(url) {
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
            res.on('end', () => res.statusCode >= 200 && res.statusCode < 300 ? resolve(body) : reject(new Error(`Bright Data request failed with status ${res.statusCode}: ${body}`)) );
        });
        request.on('error', (e) => reject(e));
        request.end();
    });
}

const ANALYSIS_PROMPT = `Act as a senior design consultant for \"Minimind Agency\", a creative agency specializing in branding, marketing, and web design. Your tone is professional, friendly, and helpful. You are analyzing the following HTML content from a business's Facebook page. Analyze the HTML and text for branding, marketing, and technical issues from a design agency's perspective. Specifically look for: 1.  **Branding & Content:** Is there a clear 'About Us' section? Is the language professional? Are there spelling/grammar errors? Is there a consistent brand message? 2.  **Marketing & CTA:** Is there a clear Call-to-Action (e.g., \"Send Message\", \"Shop Now\")? Is contact information (email, phone) easily found? 3.  **Technical SEO:** Are important meta tags for sharing (like og:title, og:description, og:image) present in the HTML <head>? Is there a link to an external website? Is it mobile-friendly (look for viewport meta tag)? Based on your analysis, you MUST return ONLY a single, minified JSON object. Do not include any text or formatting before or after the JSON object. The JSON object must have the following structure: {\"overall_score\": <an integer score from 0-100 based on the severity and number of issues found>,\"issues\": [ { \"type\": \"Branding\" | \"Marketing\" | \"Content Quality\" | \"Technical SEO\", \"severity\": \"High\" | \"Medium\" | \"Low\", \"description\": \"A concise description of a specific issue found.\" } ],\"suggestions\": [ { \"title\": \"A short, catchy title for a proposal point.\", \"description\": \"A one-sentence description of a service Minimind Agency can offer to fix an issue. Frame it as a solution.\" } ],\"rationale\": \"A 1-2 sentence, human-readable explanation for the score and decision, from the perspective of the AI agent.\" }`;

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
            url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
            headers = { 'Content-Type': 'application/json' };
            postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
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
        const req = https.request(url, { method: 'POST', headers, timeout: 30000 }, (res) => {
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
        const htmlContent = await getPageContent(pageUrl);
        const provider = process.env.API_PROVIDER?.toLowerCase();
        const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`];
        if (!apiKey || apiKey.includes('Your-')) throw new Error(`API key for '${provider}' is not set correctly.`);

        console.log(`Using AI Provider: ${provider} for analysis`);
        const analysisResult = await createApiRequest(provider, apiKey, { content: htmlContent, pageName: pageName }, 'analyze');
        res.status(200).json(analysisResult);

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

app.listen(port, () => {
    console.log(`Backend server listening on port ${port}`);
});