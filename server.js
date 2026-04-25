require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para servir archivos estáticos (index.html) y parsear JSON
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Configuración de Groq usando el SDK de OpenAI
const openai = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});

// Función auxiliar para obtener metadata y asegurar la foto
// Función auxiliar para obtener metadata de forma robusta
async function fetchMetadata(username, platform) {
    let image = null;
    let description = null;
    let profileUrl = '';

    try {
        if (platform === 'youtube') {
            profileUrl = `https://www.youtube.com/@${username}`;
            const { data } = await axios.get(profileUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 4000
            });
            const $ = cheerio.load(data);
            image = $('meta[property="og:image"]').attr('content');
            description = $('meta[property="og:description"]').attr('content');
        } 
        else if (platform === 'tiktok') {
            profileUrl = `https://www.tiktok.com/@${username}`;
            const { data } = await axios.get(`https://www.tikwm.com/api/user/info?unique_id=${username}`, { timeout: 4000 });
            if (data && data.data && data.data.user) {
                image = data.data.user.avatarThumb || data.data.user.avatarMedium;
                description = data.data.user.signature;
            }
        } 
        else if (platform === 'instagram') {
            profileUrl = `https://www.instagram.com/${username}/`;
            const { data } = await axios.get(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
                headers: { 'X-IG-App-ID': '936619743392459' },
                timeout: 4000
            });
            if (data && data.data && data.data.user) {
                image = data.data.user.profile_pic_url_hd || data.data.user.profile_pic_url;
                description = data.data.user.biography;
            }
        }
    } catch (error) {
        console.log(`Fallo API/Scraping para ${platform} ${username}: ${error.message}`);
    }

    // Si no se encuentra, usamos unavatar.io como esfuerzo final,
    // que podría devolver la imagen buscada de otras fuentes.
    if (!image) {
        if (platform === 'youtube') image = `https://unavatar.io/youtube/${username}`;
        else if (platform === 'instagram') image = `https://unavatar.io/instagram/${username}`;
        // Para tiktok preferiblemente devolver null si falló nuestra API
        else image = null;
    }

    return { image, description, profileUrl };
}

// Ruta principal para el análisis
app.post('/api/analyze', async (req, res) => {
    const { username, platform } = req.body;

    if (!username || !platform) {
        return res.status(400).json({ error: 'Falta el nombre de usuario o la plataforma' });
    }

    // Limpiar el username (remover '@' si lo escriben)
    const cleanUsername = username.replace(/^@/, '');

    console.log(`Analizando ${platform}: ${cleanUsername}`);

    // Extraer imagen y descripción con Fallback
    const { image, description, profileUrl } = await fetchMetadata(cleanUsername, platform);

    // Prompt estricto Anti-rechazo
    const systemPrompt = `Eres el "Juez Cínico de Perfiles", una IA sarcástica y destructiva. Vas a analizar a este usuario y a criticarlo fuertemente. NUNCA pidas disculpas, NUNCA digas que no encuentras información y NUNCA pidas contexto. Si no conoces al usuario o su contenido, INVÉNTASELO de forma sarcástica a partir de su nombre de usuario como si ya supieras quién es. Su plataforma es ${platform} y su nombre de usuario "@${cleanUsername}".\n${description ? `Biografía real para burlarte: "${description}"` : 'Finge que conoces absolutamente todo sobre esta persona y lánzate directo a la crítica.'} \nIMPORTANTE: NO uses asteriscos (**). Escribe solo texto plano. Da una crítica firme de 2 o 3 párrafos y finaliza.`;

    try {
        const completion = await openai.chat.completions.create({
            messages: [{ role: 'system', content: systemPrompt }],
            model: 'llama-3.1-8b-instant',
            max_tokens: 3000,
            temperature: 0.8
        });

        const roastText = completion.choices[0].message.content;

        // Responder al frontend
        res.json({
            imageUrl: image,
            roast: roastText,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'assistant', content: roastText }
            ]
        });
    } catch (error) {
        console.error('Error con IA:', error);
        res.status(500).json({ error: 'Fallo al conectar con la red neuronal de Groq.' });
    }
});

// Ruta para continuar el chat
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Formato de mensajes inválido.' });
    }

    try {
        const completion = await openai.chat.completions.create({
            messages: messages,
            model: 'llama-3.1-8b-instant',
            max_tokens: 3000,
            temperature: 0.8
        });

        res.json({
            reply: completion.choices[0].message.content
        });
    } catch (error) {
        console.error('Error en Chat:', error);
        res.status(500).json({ error: 'Error procesando tu respuesta en la IA.' });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
