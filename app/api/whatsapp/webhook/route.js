import { NextResponse } from 'next/server';

// التحقق الأولي من Meta عند ربط الـ Webhook (مرة واحدة عند الإعداد)
export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// استقبال الرسائل الفعلية من واتساب (نص، صوت، مستند...)
export async function POST(req) {
  const body = await req.json();

  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return NextResponse.json({ status: 'ignored' });
    }

    const from = message.from; // رقم المرسل
    const type = message.type; // text | audio | document | image ...

    // التفرّع حسب نوع الرسالة — يُوسَّع كل قسم لاحقًا بمنطقه الخاص
    switch (type) {
      case 'text': {
        const text = message.text?.body;
        // TODO: تمرير النص لمعالجة المساعد (نفس منطق /api/assistant)
        console.log('نص وارد من', from, ':', text);
        break;
      }
      case 'audio': {
        const mediaId = message.audio?.id;
        // TODO: تحميل الملف عبر Graph API، ثم faster-whisper لتحويله لنص
        console.log('رسالة صوتية واردة من', from, 'media id:', mediaId);
        break;
      }
      case 'document': {
        const mediaId = message.document?.id;
        // TODO: تحميل المستند، استخراج نص/OCR، ثم تلخيص
        console.log('مستند وارد من', from, 'media id:', mediaId);
        break;
      }
      default:
        console.log('نوع رسالة غير معالج بعد:', type);
    }

    return NextResponse.json({ status: 'received' });
  } catch (err) {
    console.error('خطأ في معالجة الـ webhook:', err);
    return NextResponse.json({ status: 'error' }, { status: 500 });
  }
}
