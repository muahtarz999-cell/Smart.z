export const runtime = 'edge';

import { NextResponse } from 'next/server';

// جدار الصلاحيات: أي فعل هنا مصنّف كـ "تلقائي" أو "يحتاج تأكيد".
const AUTO_ALLOWED_ACTIONS = ['summarize', 'transcribe', 'answer'];
const REQUIRES_CONFIRMATION = ['send_message', 'add_contact'];

export async function POST(req) {
  try {
    const { message } = await req.json();

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { reply: 'لم يصل أي نص لمعالجته.' },
        { status: 400 }
      );
    }

    const token = process.env.GITHUB_MODELS_TOKEN;
    if (!token) {
      console.error('[Assistant API Error] Missing GITHUB_MODELS_TOKEN environment variable.');
      return NextResponse.json(
        {
          reply:
            'لم يتم إعداد مفتاح النموذج بعد. أضف GITHUB_MODELS_TOKEN في إعدادات البيئة على Cloudflare.',
        },
        { status: 500 }
      );
    }

    // نداء النموذج عبر GitHub Models (نقطة نهاية متوافقة مع OpenAI / Azure)
    const response = await fetch(
      'https://models.inference.ai.azure.com/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                'أنت مساعد شخصي ذكي لرجل أعمال. أجب بالعربية الفصحى الواضحة، ' +
                'بإيجاز ومباشرة، وبأسلوب احترافي هادئ.',
            },
            { role: 'user', content: message },
          ],
          temperature: 0.7,
          max_tokens: 1000,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(
        `[Assistant API Error] Status: ${response.status} ${response.statusText}`
      );
      console.error(`[Assistant API Error] Response Body: ${errText}`);
      return NextResponse.json(
        {
          reply: `تعذر الاتصال بالنموذج حاليًا (رمز الخطأ: ${response.status}). حاول بعد قليل.`,
          details: errText,
        },
        { status: response.status }
      );
    }

    const data = await response.json();
    const reply =
      data.choices?.[0]?.message?.content || 'لم يصل رد من النموذج.';

    return NextResponse.json({ reply });
  } catch (err) {
    console.error('[Assistant API Unexpected Error]:', err);
    return NextResponse.json(
      { reply: 'حدث خطأ غير متوقع في خادم المساعد.' },
      { status: 500 }
    );
  }
}
