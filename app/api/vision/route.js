import { json } from '../../../lib/api-response';
import { customerAccessResponse, requireCustomerRegistered } from '../../../lib/customer-access';
import { sanitizeHistory } from '../../../lib/assistant-response';
import { analyzeImages, MAX_IMAGE_BASE64_LENGTH, MAX_VISION_IMAGES } from '../../../lib/vision';


// Questions about photos and scanned pages. Images are analysed and discarded; nothing is stored or logged.
export async function POST(request) {
  const access = await requireCustomerRegistered(request);
  if (!access.ok) return customerAccessResponse(access);

  const body = await request.json().catch(() => null);
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 2000) : '';
  const images = (Array.isArray(body?.images) ? body.images : [])
    .filter((image) => typeof image === 'string' && image.length > 100 && image.length <= MAX_IMAGE_BASE64_LENGTH)
    .slice(0, MAX_VISION_IMAGES);
  if (!question || !images.length) return json({ error: true, message: 'السؤال والصورة مطلوبان.' }, 400);

  const pages = Array.isArray(body.pages) && body.pages.length ? ` (الصفحات ${body.pages.join('، ')} من ملف «${String(body.fileName || '').slice(0, 80)}»)` : '';
  try {
    const result = await analyzeImages({
      question,
      images,
      systemExtra: [
        pages ? `الصور المرفقة هي صفحات مصوّرة${pages}.` : '',
        body.channel === 'voice' ? 'الرد سيُقرأ بصوت عالٍ: جمل قصيرة، بلا رموز أو جداول، والأرقام بالكلمات.' : '',
      ].filter(Boolean).join('\n'),
      history: sanitizeHistory(body.history),
    });
    return json({ reply: result.reply });
  } catch (error) {
    console.error('[Vision API] failed', { code: error?.code, failures: error?.failures });
    return json({
      error: true,
      code: error?.code || 'VISION_FAILED',
      message: error?.code === 'NO_PROVIDERS' ? 'خدمة قراءة الصور غير مضبوطة.' : 'تعذر تحليل الصورة الآن.',
    }, error?.code === 'NO_PROVIDERS' ? 503 : 502);
  }
}
