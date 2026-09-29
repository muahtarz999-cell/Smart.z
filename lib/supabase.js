import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// ملاحظة: كل استعلام يجب أن يتقيد بـ client_id الخاص بصاحب الجلسة
// (يُفرض لاحقًا عبر Row Level Security في Supabase نفسه، وليس فقط هنا).
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
