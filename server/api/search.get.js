import { defineEventHandler, getQuery, getHeader } from 'h3';

export default defineEventHandler(async (event) => {
    const query = getQuery(event);
    
    // Get API key from header
    const apiKey = getHeader(event, 'x-api-key');
    
    if (!apiKey) {
        throw createError({
            statusCode: 401,
            statusMessage: 'API key is required in X-API-Key header.'
        });
    }

    const { q, numResults = 5 } = query;

    if (!q) {
        throw createError({
            statusCode: 400,
            statusMessage: 'Query parameter "q" is required.'
        });
    }

    try {
        const response = await fetch('https://ai.hackclub.com/proxy/v1/exa/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                query: q,
                numResults: Math.min(parseInt(numResults) || 5, 10),
                contents: {
                    highlights: true
                }
            })
        });

        if (!response.ok) {
            throw createError({
                statusCode: response.status,
                statusMessage: `Exa Search API failed: ${response.statusText}`
            });
        }

        const data = await response.json();
        
        // Transform Exa API response to match expected format
        return {
            results: data.results?.map(r => ({
                title: r.title || '',
                url: r.url || '',
                highlights: Array.isArray(r.highlights) ? r.highlights : [],
                author: r.author || null,
                date: r.publishedDate || null,
                subpages: Array.isArray(r.subpages) ? r.subpages : []
            })) || [],
            query: q
        };

    } catch (error) {
        console.error('Exa Search API Error:', error);
        throw createError({
            statusCode: error.statusCode || 500,
            statusMessage: error.statusMessage || 'Internal Server Error'
        });
    }
});
