import { NextResponse } from 'next/server';

export const runtime = 'edge';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const SYSTEM_MESSAGE = `أنت المساعد الشخصي الذكي Smart.z. افهم العربية ولهجاتها جيدًا، وأجب باللغة التي يستخدمها المستخدم، وبالعربية عندما يكتب بالعربية. اجعل إجاباتك واضحة ومختصرة. لا تخترع معلومات غير معروفة؛ وضّح ما لا تعرفه عند الحاجة. لا تذكر تفاصيل تقنية داخلية إلا إذا كانت ضرورية للإجابة، ولا تدّع تنفيذ أي إجراء لم تنفذه فعليًا.`;

function errorResponse(message, status) {
  return NextResponse.json({ error: true, message }, { status });
}

export async function POST(request) {
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

  try {
    const groqResponse = await fetch(GROQ_ENDPOINT, {
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

    if (!groqResponse.ok) {
      return errorResponse('Assistant service is temporarily unavailable.', 502);
    }

    const result = await groqResponse.json();
    const reply = result.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      return errorResponse('Assistant service returned an invalid response.', 502);
    }

    return NextResponse.json({ reply: reply.trim() });
  } catch {
    return errorResponse('Assistant service is temporarily unavailable.', 502);
  }
}
