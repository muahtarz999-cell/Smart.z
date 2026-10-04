import { NextResponse } from 'next/server';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';

export const runtime = 'edge';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'openai/gpt-oss-120b';
const SYSTEM_MESSAGE = `أنت المساعد الشخصي الذكي Smart.z. افهم العربية ولهجاتها جيدًا، وأجب باللغة التي يستخدمها المستخدم، وبالعربية عندما يكتب بالعربية. اجعل إجاباتك واضحة ومختصرة. لا تخترع معلومات غير معروفة؛ وضّح ما لا تعرفه عند الحاجة. لا تذكر تفاصيل تقنية داخلية إلا إذا كانت ضرورية للإجابة، ولا تدّع تنفيذ أي إجراء لم تنفذه فعليًا.`;

function errorResponse(message, status) {
  return NextResponse.json({ error: true, message }, { status });
}

function sanitizeDiagnosticMessage(message, apiKey) {
  if (typeof message !== 'string') return undefined;

  let sanitized = apiKey ? message.split(apiKey).join('[REDACTED]') : message;
  sanitized = sanitized
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gsk_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/gi, '[REDACTED]');

  return sanitized.slice(0, 500);
}

function getErrorType(error) {
  return typeof error?.name === 'string' ? error.name : 'Error';
}

export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON request.', 400);
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return errorResponse('A non-empty message is required.', 400);
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return errorResponse(
      'API key missing or authentication failed.',
      500
    );
  }

  let groqResponse;
  try {
    groqResponse = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_MESSAGE },
          { role: 'user', content: message },
        ],
      }),
    });
  } catch (error) {
    const causeCode = error?.cause?.code;
    console.error('[Assistant API] Groq fetch failed', {
      errorType: getErrorType(error),
      message: sanitizeDiagnosticMessage(error?.message, apiKey),
      ...(typeof causeCode === 'string'
        ? { causeCode: sanitizeDiagnosticMessage(causeCode, apiKey) }
        : typeof causeCode === 'number'
          ? { causeCode }
          : {}),
    });
    return errorResponse('Assistant service is temporarily unavailable.', 502);
  }

  if (!groqResponse.ok) {
    let groqErrorMessage;
    try {
      const errorData = await groqResponse.json();
      groqErrorMessage = sanitizeDiagnosticMessage(
        errorData?.error?.message,
        apiKey
      );
    } catch (error) {
      console.error('[Assistant API] Groq error response JSON parsing failed', {
        errorType: getErrorType(error),
        status: groqResponse.status,
      });
    }

    console.error('[Assistant API] Groq request failed', {
      status: groqResponse.status,
      ...(groqResponse.statusText ? { statusText: groqResponse.statusText } : {}),
      ...(groqErrorMessage ? { groqErrorMessage } : {}),
    });
    return errorResponse('Assistant service is temporarily unavailable.', 502);
  }

  let result;
  try {
    result = await groqResponse.json();
  } catch (error) {
    console.error('[Assistant API] Groq success response JSON parsing failed', {
      errorType: getErrorType(error),
    });
    return errorResponse('Assistant service is temporarily unavailable.', 502);
  }

  const reply = result?.choices?.[0]?.message?.content;
  if (typeof reply !== 'string' || !reply.trim()) {
    console.error('[Assistant API] Groq response missing reply content', {
      responseType: result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result,
      choicesType: Array.isArray(result?.choices) ? 'array' : typeof result?.choices,
      choiceCount: Array.isArray(result?.choices) ? result.choices.length : 0,
      contentType: typeof reply,
    });
    return errorResponse('Assistant service returned an invalid response.', 502);
  }

  return NextResponse.json({ reply: reply.trim() });
}
