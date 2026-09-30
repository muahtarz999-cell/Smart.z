export const runtime = 'edge';

import { NextResponse } from 'next/server';

// جدار الصلاحيات: أي فعل هنا مصنّف كـ "تلقائي" أو "يحتاج تأكيد".
// هذا مجرد هيكل أولي — يُوسَّع لاحقًا حسب الأفعال الفعلية (إرسال، قراءة...).
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
      return NextResponse.json({
        reply:
          'لم يتم إعداد مفتاح النموذج بعد. أضف GITHUB_MODELS_TOKEN في إعدادات البيئة.',
      });
    }

    // نداء نموذج عبر GitHub Models (نقطة نهاية متوافقة مع صيغة OpenAI/Azure).
    const response = await fetch(
      'https://models.inference.ai.azure.com/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content:
                'أنت مساعد شخصي ذكي لرجل أعمال. أجب بالعربية الفصحى الواضحة، ' +
                'بإيجاز ومباشرة، وبأسلوب احترافي هادئ.',
            },
            { role: 'user', content: message },
          ],
          temperature: 0.4,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('GitHub Models error:', errText);
      return NextResponse.json({
        reply: 'تعذر الاتصال بالنموذج حاليًا، حاول بعد قليل.',
      });
    }

    const data = await response.json();
    const reply =
      data.choices?.[0]?.message?.content || 'لم يصل رد من النموذج.';

    return NextResponse.json({ reply });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { reply: 'حدث خطأ غير متوقع.' },
      { status: 500 }
    );
  }
}
