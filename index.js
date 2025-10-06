
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// --- Super Simple Echo Endpoint for Debugging ---
app.post('/chat', async (req, res) => {
    const { prompt } = req.body;
    console.log(`Received chat prompt: ${prompt}`); // Log that we received the request

    if (!prompt) {
        return res.status(400).json({ error: 'prompt is required.' });
    }

    // Just echo the prompt back
    const reply = `You said: "${prompt}"`;
    
    console.log(`Sending reply: ${reply}`);
    res.status(200).json({ reply: reply });
});

app.post('/analyze', async (req, res) => {
    res.status(501).json({ error: 'Analyze endpoint is temporarily disabled for debugging.' });
});

app.listen(port, () => {
    console.log(`Backend server (in debug/echo mode) listening on port ${port}`);
});
