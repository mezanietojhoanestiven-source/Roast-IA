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

// Función auxiliar: intenta obtener metadata Y determina si la cuenta existe
// Retorna: { image, description, profileUrl, exists, blocked }
// - exists: true = cuenta confirmada, false = cuenta NO existe (404 real)
// - blocked: true = la plataforma nos bloqueó (no podemos confirmar existencia)
async function fetchMetadata(username, platform) {
    let image = null;
    let description = null;
    let profileUrl = '';
    let exists = false;   // por defecto asumimos que no existe hasta confirmarlo
    let blocked = false;  // indica que la plataforma nos bloqueó (no es 404)

    try {
        // ── YOUTUBE ──────────────────────────────────────────────────────────
        if (platform === 'youtube') {
            profileUrl = `https://www.youtube.com/@${username}`;
            // Un canal inexistente devuelve HTTP 404; uno existente devuelve 200
            const { data, status } = await axios.get(profileUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36' },
                timeout: 6000,
                validateStatus: (s) => true // No lanzar error, capturar el status
            });

            if (status === 404) {
                // Canal inexistente confirmado
                exists = false;
            } else if (status === 200) {
                const $ = cheerio.load(data);
                image = $('meta[property="og:image"]').attr('content') || null;
                description = $('meta[property="og:description"]').attr('content') || null;
                // YouTube siempre tiene og:image si el canal existe
                exists = !!image;
            } else {
                // Bloqueado (429, 503, etc.) — no podemos confirmar, asumimos que existe
                blocked = true;
                exists = true;
            }
        }

        // ── TIKTOK ───────────────────────────────────────────────────────────
        else if (platform === 'tiktok') {
            profileUrl = `https://www.tiktok.com/@${username}`;
            const { data } = await axios.get(
                `https://www.tikwm.com/api/user/info?unique_id=${username}`,
                { timeout: 6000 }
            );

            // La API de tikwm devuelve code=0 si encontró el usuario
            if (data && data.code === 0 && data.data && data.data.user) {
                image = data.data.user.avatarThumb || data.data.user.avatarMedium || null;
                description = data.data.user.signature || null;
                exists = true; // Confirmado
            } else {
                // code != 0 o sin user = no existe
                exists = false;
            }
        }

        // ── INSTAGRAM ────────────────────────────────────────────────────────
        else if (platform === 'instagram') {
            profileUrl = `https://www.instagram.com/${username}/`;
            const { data, status } = await axios.get(
                `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
                {
                    headers: {
                        'X-IG-App-ID': '936619743392459',
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
                        'Accept': 'application/json'
                    },
                    timeout: 6000,
                    validateStatus: (s) => true // Capturar todos los status
                }
            );

            if (status === 200 && data && data.data && data.data.user) {
                // Usuario encontrado y la API respondió con datos
                image = data.data.user.profile_pic_url_hd || data.data.user.profile_pic_url || null;
                description = data.data.user.biography || null;
                exists = true; // Confirmado
            } else if (status === 404) {
                // La API devuelve 404 explícito cuando el username no existe
                exists = false;
            } else {
                // 401 / 403 / 429 = Instagram nos bloqueó, pero el usuario PUEDE existir
                // En este caso, asumimos que existe para no dar falsos negativos
                console.log(`Instagram bloqueó la solicitud (HTTP ${status}), asumiendo que existe.`);
                blocked = true;
                exists = true;
            }
        }

    } catch (error) {
        // Error de red (timeout, ECONNREFUSED, etc.) — no podemos confirmar
        console.log(`Error de red para ${platform}/@${username}: ${error.message}`);
        blocked = true;
        exists = true; // En caso de duda, no bloqueamos al usuario
    }

    // Fallback de imagen solo si la cuenta existe pero no obtuvimos foto
    if (exists && !image) {
        if (platform === 'youtube')   image = `https://unavatar.io/youtube/${username}`;
        if (platform === 'instagram') image = `https://unavatar.io/instagram/${username}`;
    }

    return { image, description, profileUrl, exists, blocked };
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

    // Extraer imagen, descripción y flag de existencia
    const { image, description, profileUrl, exists, blocked } = await fetchMetadata(cleanUsername, platform);

    // Si la plataforma confirmó con certeza que el usuario NO existe → 404
    // Si "blocked" es true, pasamos de largo (no sabemos con certeza si existe o no)
    if (!exists && !blocked) {
        console.log(`Cuenta no encontrada (confirmado): ${platform} @${cleanUsername}`);
        return res.status(404).json({
            error: '❌ No se encontró esa cuenta. Por favor, revisa el nombre e inténtalo de nuevo.'
        });
    }

    // Prompt estricto con rol de Juez/Auditor de redes sociales
    const systemPrompt = `Eres el "Juez Cínico de Perfiles", una IA auditora especializada EXCLUSIVAMENTE en analizar perfiles de Instagram, TikTok y YouTube. Tu único propósito es juzgar y criticar perfiles de redes sociales de forma sarcástica y directa. NUNCA pidas disculpas, NUNCA digas que no encuentras información. Su plataforma es ${platform} y su nombre de usuario "@${cleanUsername}".\n${description ? `Biografía real para burlarte: "${description}"` : 'Analiza al usuario basándote en su nombre de usuario.'} \nIMPORTANTE: NO uses asteriscos (**). Escribe solo texto plano. Da una crítica firme de 2 o 3 párrafos y finaliza.\nSi en el chat posterior alguien te habla de CUALQUIER tema que NO sea analizar perfiles de redes sociales, responde SIEMPRE con: "No puedo ayudarte con eso. Soy el Juez Cínico de Perfiles, una auditora de Instagram, TikTok y YouTube. ¿Tienes alguna queja sobre mi veredicto o quieres que analice otro perfil?"`;

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

    // Reforzar el rol del Juez en cada mensaje del chat para evitar desvíos de tema
    const reinforcedMessages = messages.map((msg, index) => {
        if (index === 0 && msg.role === 'system') {
            // Asegurarse de que el system prompt siempre tenga la restricción de tema
            const restriction = `\n\nREGLA ABSOLUTA E INQUEBRANTABLE: Solo puedes hablar sobre análisis de perfiles de redes sociales (Instagram, TikTok, YouTube). Si el usuario habla de CUALQUIER otro tema (política, comida, tecnología, filosofía, código, etc.), DEBES responder EXACTAMENTE con: "No puedo ayudarte con eso. Soy el Juez Cínico de Perfiles, una auditora especializada en Instagram, TikTok y YouTube. ¿Tienes alguna queja sobre mi veredicto o quieres analizar otro perfil?" Sin excepciones.`;
            return { ...msg, content: msg.content + restriction };
        }
        return msg;
    });

    try {
        const completion = await openai.chat.completions.create({
            messages: reinforcedMessages,
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
