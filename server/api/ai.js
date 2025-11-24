import { defineEventHandler, readBody } from 'h3';
import OpenAI from 'openai';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);

  const config = useRuntimeConfig(event);
  const apiKey = config.hackclubApiKey;

  const openai = new OpenAI({
    apiKey: apiKey || '',
    baseURL: 'https://ai.hackclub.com/proxy/v1'
  });

  try {
    const {
      stream = true,
      ...rest
    } = body;

    // Whitelisted core fields; allow pass-through of others
    const completionParams = {
      ...rest,
      stream
      // rest may include: model, messages, tools, tool_choice,
      // parallel_tool_calls, temperature, top_p, seed, reasoning, plugins, etc.
    };

    if (!stream) {
      const completion = await openai.chat.completions.create({
        ...completionParams,
        stream: false,
      });

      event.node.res.setHeader('Content-Type', 'application/json');
      event.node.res.end(JSON.stringify(completion));
      return;
    }

    // Streaming branch
    const streamResp = await openai.chat.completions.create({
      ...completionParams,
      stream: true,
    });

    event.node.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    event.node.res.setHeader('Cache-Control', 'no-cache');
    event.node.res.setHeader('Connection', 'keep-alive');
    event.node.res.setHeader('Transfer-Encoding', 'chunked');

    for await (const chunk of streamResp) {
      event.node.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    event.node.res.write('data: [DONE]\n\n');
    event.node.res.end();

  } catch (error) {
    console.error('Error creating chat completion:', error);

    if (body.stream === false) {
      event.node.res.setHeader('Content-Type', 'application/json');
      event.node.res.statusCode = 500;
      event.node.res.end(JSON.stringify({
        error: {
          type: error.type || 'api_error',
          message: error.message || 'Failed to connect to AI service',
          code: error.status || 500
        }
      }));
    } else {
      event.node.res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      event.node.res.setHeader('Cache-Control', 'no-cache');
      event.node.res.setHeader('Connection', 'keep-alive');

      const errorChunk = {
        error: {
          type: error.type || 'api_error',
          message: error.message || 'Failed to connect to AI service',
          code: error.status || 500
        }
      };

      event.node.res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      event.node.res.write('data: [DONE]\n\n');
      event.node.res.end();
    }
  }
});