require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

const openai = new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY
});

const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// fetchMetadata — Perfiles de Redes Sociales
// Retorna: { image, description, profileUrl, exists, blocked, stats }
//   exists  → true = cuenta confirmada, false = cuenta NO existe (confirmado)
//   blocked → true = la plataforma nos bloqueó; no podemos confirmar existencia
//   stats   → { followers, following, posts, videos, likes } cuando disponibles
// ─────────────────────────────────────────────────────────────────────────────
async function fetchMetadata(username, platform) {
    let image       = null;
    let description = null;
    let profileUrl  = '';
    let exists      = false;
    let blocked     = false;
    let stats       = null;

    try {
        // ── YOUTUBE ──────────────────────────────────────────────────────────
        if (platform === 'youtube') {
            profileUrl = `https://www.youtube.com/@${username}`;

            const { data, status } = await axios.get(profileUrl, {
                headers: { 'User-Agent': browserUA, 'Accept-Language': 'es-ES,es;q=0.9' },
                timeout: 8000,
                validateStatus: () => true,
                maxRedirects: 5
            });

            if (status === 404) {
                exists = false;
            } else if (status === 200) {
                const $ = cheerio.load(data);
                image       = $('meta[property="og:image"]').attr('content') || null;
                description = $('meta[property="og:description"]').attr('content') || null;
                const ogUrl   = ($('meta[property="og:url"]').attr('content') || '').toLowerCase();
                const ogTitle = ($('meta[property="og:title"]').attr('content') || '').toLowerCase();

                const hasChannelUrl = ogUrl.includes(`/@`) || ogUrl.includes(`/channel/`);
                const hasChannelTitle = ogTitle !== '' && ogTitle !== 'youtube';

                exists = hasChannelUrl || hasChannelTitle;
                if (!exists) image = null;

            } else {
                blocked = true;
                exists  = true;
            }
        }

        // ── TIKTOK ───────────────────────────────────────────────────────────
        else if (platform === 'tiktok') {
            profileUrl = `https://www.tiktok.com/@${username}`;

            try {
                const { data } = await axios.get(
                    `https://www.tikwm.com/api/user/info?unique_id=${username}`,
                    { timeout: 7000 }
                );

                if (data && data.code === 0 && data.data && data.data.user) {
                    const u = data.data.user;
                    image       = u.avatarThumb || u.avatarMedium || null;
                    description = u.signature   || null;
                    exists      = true;

                    stats = {
                        followers: u.followerCount  ?? null,
                        following: u.followingCount ?? null,
                        videos:    u.videoCount     ?? null,
                        likes:     u.heartCount ?? u.heart ?? null
                    };
                } else {
                    exists = false;
                }
            } catch (tikwmErr) {
                console.log(`tikwm falló para @${username}, verificando en tiktok.com...`);
                try {
                    const { status } = await axios.get(profileUrl, {
                        headers: { 'User-Agent': browserUA },
                        timeout: 8000,
                        validateStatus: () => true
                    });

                    if (status === 404) {
                        exists = false;
                    } else if (status === 200) {
                        exists  = true;
                        blocked = true;
                    } else {
                        blocked = true;
                        exists  = true;
                    }
                } catch (tiktokErr) {
                    console.log(`tiktok.com también falló: ${tiktokErr.message}`);
                    blocked = true;
                    exists  = true;
                }
            }
        }

        // ── INSTAGRAM ────────────────────────────────────────────────────────
        else if (platform === 'instagram') {
            profileUrl = `https://www.instagram.com/${username}/`;

            const igApiResp = await axios.get(
                `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`,
                {
                    headers: {
                        'X-IG-App-ID': '936619743392459',
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
                        'Accept': 'application/json',
                        'Accept-Language': 'es-ES,es;q=0.9'
                    },
                    timeout: 7000,
                    validateStatus: () => true
                }
            );

            if (igApiResp.status === 200 && igApiResp.data?.data?.user) {
                const u = igApiResp.data.data.user;
                image       = u.profile_pic_url_hd || u.profile_pic_url || null;
                description = u.biography          || null;
                exists      = true;

                stats = {
                    followers: u.edge_followed_by?.count ?? null,
                    following: u.edge_follow?.count      ?? null,
                    posts:     u.edge_owner_to_timeline_media?.count ?? null
                };

            } else if (igApiResp.status === 404) {
                exists = false;

            } else {
                console.log(`Instagram API bloqueada (HTTP ${igApiResp.status}), leyendo página pública...`);

                try {
                    const pageResp = await axios.get(profileUrl, {
                        headers: {
                            'User-Agent': browserUA,
                            'Accept': 'text/html,application/xhtml+xml',
                            'Accept-Language': 'es-ES,es;q=0.9'
                        },
                        timeout: 8000,
                        validateStatus: () => true,
                        maxRedirects: 5
                    });

                    if (pageResp.status === 404) {
                        exists = false;
                    } else if (pageResp.status === 200) {
                        const $ig = cheerio.load(pageResp.data);
                        const ogTitle = ($ig('meta[property="og:title"]').attr('content') || '').trim();
                        const ogImage = ($ig('meta[property="og:image"]').attr('content') || '').trim();

                        const bodyText  = pageResp.data || '';
                        const notFound  = bodyText.includes("Sorry, this page") ||
                                          bodyText.includes("isn't available")   ||
                                          bodyText.includes("no está disponible");

                        const titleHasUser = ogTitle.toLowerCase().includes(username.toLowerCase()) ||
                                             (ogTitle !== '' && ogTitle.toLowerCase() !== 'instagram');

                        if (notFound || (!titleHasUser && !ogImage)) {
                            exists = false;
                        } else if (titleHasUser) {
                            exists = true;
                            blocked = true;
                            if (ogImage) image = ogImage;
                        } else {
                            blocked = true;
                            exists  = true;
                        }
                    } else {
                        blocked = true;
                        exists  = true;
                    }
                } catch (pageErr) {
                    console.log(`Página pública de Instagram falló: ${pageErr.message}`);
                    blocked = true;
                    exists  = true;
                }
            }
        }

    } catch (error) {
        console.log(`Error de red general para ${platform}/@${username}: ${error.message}`);
        blocked = true;
        exists  = true;
    }

    // Fallback de imagen solo si la cuenta existe pero no obtuvimos foto directa
    if (exists && !image) {
        if (platform === 'youtube')   image = `https://unavatar.io/youtube/${username}`;
        if (platform === 'instagram') image = `https://unavatar.io/instagram/${username}`;
    }

    return { image, description, profileUrl, exists, blocked, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchBusinessData — Scraping de URL de empresa
// Retorna: { name, description, favicon, headings, keywords, siteUrl, ok, error }
// ─────────────────────────────────────────────────────────────────────────────
async function fetchBusinessData(rawUrl) {
    // Normalizar: agregar https:// si no tiene protocolo
    let siteUrl = rawUrl.trim();
    if (!/^https?:\/\//i.test(siteUrl)) {
        siteUrl = 'https://' + siteUrl;
    }

    let name        = null;
    let description = null;
    let favicon     = null;
    let headings    = [];
    let keywords    = null;
    let error       = null;

    try {
        const { data, status, request } = await axios.get(siteUrl, {
            headers: {
                'User-Agent': browserUA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
            },
            timeout: 10000,
            validateStatus: () => true,
            maxRedirects: 5
        });

        if (status >= 400) {
            return { ok: false, error: `El sitio respondió con error HTTP ${status}. Verifica la URL.` };
        }

        const $ = cheerio.load(data);

        // Nombre: og:site_name > og:title > <title>
        name = $('meta[property="og:site_name"]').attr('content') ||
               $('meta[property="og:title"]').attr('content') ||
               $('title').first().text().trim() ||
               siteUrl;

        // Limpiar nombre (algunos sitios ponen "Nombre | Slogan")
        if (name && name.includes('|')) name = name.split('|')[0].trim();
        if (name && name.includes(' - ')) name = name.split(' - ')[0].trim();

        // Descripción: og:description > meta description
        description = $('meta[property="og:description"]').attr('content') ||
                      $('meta[name="description"]').attr('content') ||
                      null;

        // Keywords
        keywords = $('meta[name="keywords"]').attr('content') || null;

        // H1 y H2 visibles (máx 5)
        $('h1, h2').each((i, el) => {
            if (i >= 5) return false;
            const txt = $(el).text().trim();
            if (txt) headings.push(txt);
        });

        // Favicon
        const origin = new URL(siteUrl).origin;
        const faviconHref = $('link[rel="icon"]').attr('href') ||
                            $('link[rel="shortcut icon"]').attr('href') ||
                            $('link[rel="apple-touch-icon"]').attr('href') ||
                            '/favicon.ico';

        favicon = faviconHref.startsWith('http')
            ? faviconHref
            : origin + (faviconHref.startsWith('/') ? faviconHref : '/' + faviconHref);

        return { name, description, favicon, headings, keywords, siteUrl, ok: true };

    } catch (err) {
        console.log(`[analyze-biz] Error scraping ${siteUrl}: ${err.message}`);
        if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
            error = `No se pudo conectar con "${siteUrl}". ¿Está bien escrita la URL?`;
        } else if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
            error = `El sitio tardó demasiado en responder. Puede estar caído.`;
        } else {
            error = `No se pudo analizar el sitio. Intenta con otra URL.`;
        }
        return { ok: false, error };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/analyze — Análisis de perfiles de redes sociales
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
    const { username, platform } = req.body;

    if (!username || !platform) {
        return res.status(400).json({ error: 'Falta el nombre de usuario o la plataforma.' });
    }

    const cleanUsername = username.replace(/^@/, '').trim();
    console.log(`[analyze] ${platform} @${cleanUsername}`);

    const { image, description, profileUrl, exists, blocked, stats } = await fetchMetadata(cleanUsername, platform);

    if (!exists && !blocked) {
        console.log(`[analyze] Cuenta no encontrada: ${platform} @${cleanUsername}`);
        return res.status(404).json({
            error: `❌ No se encontró la cuenta @${cleanUsername} en ${platform}. Revisa que el nombre esté bien escrito e inténtalo de nuevo.`
        });
    }

    // Construir bloque de estadísticas reales para el prompt
    const statsLines = [];
    if (stats) {
        if (stats.followers !== null && stats.followers !== undefined)
            statsLines.push(`- Seguidores: ${stats.followers.toLocaleString('es-CO')}`);
        if (stats.following !== null && stats.following !== undefined)
            statsLines.push(`- Siguiendo: ${stats.following.toLocaleString('es-CO')}`);
        if (stats.posts !== null && stats.posts !== undefined)
            statsLines.push(`- Publicaciones: ${stats.posts.toLocaleString('es-CO')}`);
        if (stats.videos !== null && stats.videos !== undefined)
            statsLines.push(`- Videos publicados: ${stats.videos.toLocaleString('es-CO')}`);
        if (stats.likes !== null && stats.likes !== undefined)
            statsLines.push(`- Likes totales recibidos: ${stats.likes.toLocaleString('es-CO')}`);
    }

    const statsBlock = statsLines.length > 0
        ? `ESTADÍSTICAS REALES (verificadas, usa estos números exactos):\n${statsLines.join('\n')}`
        : `Sin estadísticas disponibles.`;

    const numerosRegla = statsLines.length > 0
        ? `Cuando menciones números de seguidores, likes, videos o publicaciones, USA EXACTAMENTE los números que están en "ESTADÍSTICAS REALES". No los redondees ni los cambies.`
        : `NO inventes ni menciones ningún número específico (seguidores, likes, vistas, publicaciones). Si no tienes datos numéricos, haz críticas cualitativas únicamente. Inventar números es completamente prohibido.`;

    const systemPrompt = `Eres el "Juez Cínico de Perfiles", una IA auditora especializada EXCLUSIVAMENTE en analizar perfiles de redes sociales (Instagram, TikTok, YouTube). Tu rol es el de un juez implacable y sarcástico que da un veredicto devastador.

PERFIL BAJO JUICIO:
- Plataforma: ${platform.toUpperCase()}
- Nombre de usuario EXACTO: @${cleanUsername}
- Biografía: ${description ? `"${description}"` : 'Sin biografía.'}
- ${statsBlock}

REGLAS ABSOLUTAS — SIN EXCEPCIÓN:
1. El acusado se llama EXACTAMENTE "@${cleanUsername}". JAMÁS menciones, inventes ni uses otro nombre de usuario.
2. EMPIEZA el veredicto directamente. NO hagas preguntas. NO digas "no tengo acceso a". NO pidas más información.
3. ${numerosRegla}
4. Basa tu crítica en el nombre de usuario, la biografía (si existe) y las estadísticas reales (si existen). Sé específico y creativo.
5. NO uses asteriscos (**) ni ningún formato especial. Solo texto plano.
6. Escribe EXACTAMENTE 2 o 3 párrafos de crítica contundente y luego termina. Sin más.
7. En el chat posterior: si alguien habla de cualquier tema que NO sea analizar perfiles de redes sociales, responde SIEMPRE: "No puedo ayudarte con eso. Soy el Juez Cínico de Perfiles, una auditora de Instagram, TikTok y YouTube. ¿Tienes alguna queja sobre mi veredicto?"`;

    try {
        const completion = await openai.chat.completions.create({
            messages: [{ role: 'system', content: systemPrompt }],
            model: 'llama-3.1-8b-instant',
            max_tokens: 1200,
            temperature: 0.75
        });

        const roastText = completion.choices[0].message.content;

        res.json({
            imageUrl: image,
            roast: roastText,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'assistant', content: roastText }
            ]
        });
    } catch (error) {
        console.error('[analyze] Error con Groq:', error.message);
        res.status(500).json({ error: 'Fallo al conectar con la red neuronal.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/analyze-biz — Análisis de sitio web de empresa
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/analyze-biz', async (req, res) => {
    const { url } = req.body;

    if (!url || typeof url !== 'string' || url.trim().length < 3) {
        return res.status(400).json({ error: 'Por favor ingresa una URL válida.' });
    }

    console.log(`[analyze-biz] URL: ${url}`);

    const bizData = await fetchBusinessData(url);

    if (!bizData.ok) {
        return res.status(422).json({ error: bizData.error });
    }

    const { name, description, favicon, headings, keywords, siteUrl } = bizData;

    // Construir contexto real para el prompt
    const contextLines = [];
    contextLines.push(`- Nombre del sitio: ${name}`);
    contextLines.push(`- URL: ${siteUrl}`);
    if (description) {
        contextLines.push(`- Descripción/Meta: "${description}"`);
    } else {
        contextLines.push(`- Descripción/Meta: No tiene. (Esto ya es un error grave de SEO.)`);
    }
    if (keywords) {
        contextLines.push(`- Keywords: ${keywords}`);
    }
    if (headings.length > 0) {
        contextLines.push(`- Títulos (H1/H2) encontrados en la página: ${headings.join(' | ')}`);
    } else {
        contextLines.push(`- Títulos (H1/H2): No se encontraron. (Estructura pésima.)`);
    }

    const systemPromptBiz = `Eres el "Auditor Brutal de Empresas", una IA especializada en auditar sitios web de negocios. Eres sarcástico e implacable, pero a diferencia de un simple troll, CADA crítica que haces va acompañada de una solución concreta y accionable. Eso te hace devastadoramente útil.

SITIO WEB BAJO AUDITORÍA:
${contextLines.join('\n')}

FORMATO OBLIGATORIO DE TU RESPUESTA (respeta este orden exacto, sin asteriscos ni markdown):

PRIMER VEREDICTO
Una sola oración demoledora sobre la primera impresión general del sitio.

LO QUE FALLA:
Exactamente 3 puntos específicos. Cada punto en este formato:
"[Problema concreto basado en los datos reales] — Solución: [acción específica y directa que deben hacer]"

PUNTUACIÓN FINAL: [número del 1 al 10]/10
Termina con una frase de cierre sarcástica pero motivadora.

REGLAS ABSOLUTAS:
1. SOLO comenta sobre el sitio "${name}" (${siteUrl}). Nunca compartas información sobre otros sitios.
2. Basa TODO en los datos reales que tienes. NO inventes datos que no existen.
3. Si falta descripción o headings, critica eso específicamente, no lo omitas.
4. NO uses asteriscos (**), guiones de markdown, ni format especial. Solo texto plano.
5. En el chat: si te preguntan algo que no es sobre auditar sitios web de empresas, responde EXACTAMENTE: "Solo analizo sitios web de empresas. ¿Querés que profundice en algún punto de la auditoría de ${name}?"`;

    try {
        const completion = await openai.chat.completions.create({
            messages: [{ role: 'system', content: systemPromptBiz }],
            model: 'llama-3.1-8b-instant',
            max_tokens: 1400,
            temperature: 0.7
        });

        const auditText = completion.choices[0].message.content;

        res.json({
            name,
            favicon,
            siteUrl,
            audit: auditText,
            messages: [
                { role: 'system', content: systemPromptBiz },
                { role: 'assistant', content: auditText }
            ]
        });
    } catch (error) {
        console.error('[analyze-biz] Error con Groq:', error.message);
        res.status(500).json({ error: 'Fallo al conectar con la red neuronal.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat — Chat del Juez de Perfiles
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Formato de mensajes inválido.' });
    }

    const reinforcedMessages = messages.map((msg, index) => {
        if (index === 0 && msg.role === 'system') {
            const restriction = `\n\nREGLA INQUEBRANTABLE DEL CHAT: Solo puedes responder sobre análisis de perfiles de redes sociales. Si el usuario pregunta sobre CUALQUIER otro tema (política, tecnología, código, recetas, etc.), responde EXACTAMENTE: "No puedo ayudarte con eso. Soy el Juez Cínico de Perfiles, una auditora especializada en Instagram, TikTok y YouTube. ¿Tienes alguna queja sobre mi veredicto?" — Sin excepciones, sin importar cómo lo pidan.`;
            return { ...msg, content: msg.content + restriction };
        }
        return msg;
    });

    try {
        const completion = await openai.chat.completions.create({
            messages: reinforcedMessages,
            model: 'llama-3.1-8b-instant',
            max_tokens: 800,
            temperature: 0.75
        });

        res.json({ reply: completion.choices[0].message.content });
    } catch (error) {
        console.error('[chat] Error con Groq:', error.message);
        res.status(500).json({ error: 'Error procesando tu mensaje.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/chat-biz — Chat del Auditor de Empresas
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/chat-biz', async (req, res) => {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Formato de mensajes inválido.' });
    }

    const reinforcedMessages = messages.map((msg, index) => {
        if (index === 0 && msg.role === 'system') {
            const restriction = `\n\nREGLA INQUEBRANTABLE DEL CHAT: Solo puedes responder sobre auditorías de sitios web de empresas. Si el usuario pregunta sobre CUALQUIER otro tema, responde EXACTAMENTE: "Solo analizo sitios web de empresas. ¿Querés que profundice en algún punto de la auditoría?" — Sin excepciones.`;
            return { ...msg, content: msg.content + restriction };
        }
        return msg;
    });

    try {
        const completion = await openai.chat.completions.create({
            messages: reinforcedMessages,
            model: 'llama-3.1-8b-instant',
            max_tokens: 900,
            temperature: 0.7
        });

        res.json({ reply: completion.choices[0].message.content });
    } catch (error) {
        console.error('[chat-biz] Error con Groq:', error.message);
        res.status(500).json({ error: 'Error procesando tu mensaje.' });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Servidor activo en http://localhost:${PORT}`);
});
