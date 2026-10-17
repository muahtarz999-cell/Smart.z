/**
 * The company that operates Smart.z, as registered with the Saudi Ministry of
 * Commerce. Used by the privacy, terms and data-deletion pages; Meta checks
 * that these match the verified business.
 *
 * NEXT_PUBLIC_CONTACT_EMAIL is read at build time: set it in Cloudflare and
 * redeploy, no code change needed.
 */
export const LEGAL_ENTITY = Object.freeze({
  nameAr: 'شركة المحترز للمقاولات العامة',
  typeAr: 'شركة ذات مسؤولية محدودة',
  typeEn: 'limited liability company',
  unifiedNumber: '7027828347',
  countryAr: 'المملكة العربية السعودية',
  countryEn: 'Kingdom of Saudi Arabia',
  product: 'Smart.z',
});

export const CONTACT_EMAIL = (process.env.NEXT_PUBLIC_CONTACT_EMAIL || 'muhtarazm@gmail.com').trim();

export const POLICY_UPDATED_AR = '17 أكتوبر 2026';
export const POLICY_UPDATED_EN = '17 October 2026';
