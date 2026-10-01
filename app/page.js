'use client';

import { useEffect, useRef, useState } from 'react';
import AssistantOrb from '../components/AssistantOrb';
import { AudioFlowManager } from '../lib/audio-flow';
import { clearAllMessages } from '../lib/conversation';

const MENU_SECTIONS = [
  { id: 'profile', label: 'ملفي' },
  { id: 'learning', label: 'التعلم والتخصيص' },
  { id: 'audio', label: 'الصوت' },
  { id: 'apps', label: 'ربط التطبيقات' },
  { id: 'privacy', label: 'الخصوصية والبيانات' },
];

const SUPPORTED_APPS = [
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'google-calendar', name: 'Google Calendar' },
  { id: 'gmail', name: 'Gmail' },
  { id: 'outlook', name: 'Microsoft Outlook' },
  { id: 'telegram', name: 'Telegram' },
];

const PROFILE_STORAGE_KEY = 'smart-assistant-profile';
const PRIVACY_STORAGE_KEY = 'smart-assistant-privacy-enabled';
const MEMORY_STORAGE_KEY = 'smart-assistant-memories';
const LOCATION_SHARING_STORAGE_KEY = 'smart-assistant-location-sharing';
const DEFAULT_PROFILE = {
  name: '',
  responseStyle: 'medium',
  language: 'ar',
};

export default function Home() {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(null);
  const [locationSharing, setLocationSharing] = useState(false);
  const [locationSharingLoaded, setLocationSharingLoaded] = useState(false);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [selectedApps, setSelectedApps] = useState([]);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [privacyEnabled, setPrivacyEnabled] = useState(true);
  const [privacyLoaded, setPrivacyLoaded] = useState(false);
  const [savedMemories, setSavedMemories] = useState([]);
  const [memoriesLoaded, setMemoriesLoaded] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [privacyMessage, setPrivacyMessage] = useState('');
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);
  const [orbState, setOrbState] = useState('idle');
  const audioFlowRef = useRef(null);
  const skipProfileSaveRef = useRef(false);

  const orbSize = expanded ? 190 : 128;
  const panelMaxWidth = expanded ? 420 : 340;

  useEffect(() => {
    try {
      const savedProfile = localStorage.getItem(PROFILE_STORAGE_KEY);
      if (savedProfile) {
        const parsedProfile = JSON.parse(savedProfile);
        setProfile({
          name: typeof parsedProfile.name === 'string' ? parsedProfile.name : DEFAULT_PROFILE.name,
          responseStyle: ['short', 'medium', 'detailed'].includes(parsedProfile.responseStyle)
            ? parsedProfile.responseStyle
            : DEFAULT_PROFILE.responseStyle,
          language: ['ar', 'en'].includes(parsedProfile.language)
            ? parsedProfile.language
            : DEFAULT_PROFILE.language,
        });
      }
    } catch (error) {
      console.warn('[Profile] Could not load saved profile:', error);
    } finally {
      setProfileLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!profileLoaded) return;
    if (skipProfileSaveRef.current) {
      skipProfileSaveRef.current = false;
      return;
    }
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch (error) {
      console.warn('[Profile] Could not save profile locally:', error);
    }
  }, [profile, profileLoaded]);

  useEffect(() => {
    try {
      const savedPrivacy = localStorage.getItem(PRIVACY_STORAGE_KEY);
      if (savedPrivacy === 'false') setPrivacyEnabled(false);
    } catch (error) {
      console.warn('[Privacy] Could not load saved setting:', error);
    } finally {
      setPrivacyLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!privacyLoaded) return;
    try {
      localStorage.setItem(PRIVACY_STORAGE_KEY, String(privacyEnabled));
    } catch (error) {
      console.warn('[Privacy] Could not save setting locally:', error);
    }
  }, [privacyEnabled, privacyLoaded]);

  useEffect(() => {
    try {
      setLocationSharing(localStorage.getItem(LOCATION_SHARING_STORAGE_KEY) === 'true');
    } catch (error) {
      console.warn('[Location sharing] Could not load saved setting:', error);
    } finally {
      setLocationSharingLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!locationSharingLoaded) return;
    try {
      localStorage.setItem(LOCATION_SHARING_STORAGE_KEY, String(locationSharing));
    } catch (error) {
      console.warn('[Location sharing] Could not save setting locally:', error);
    }
  }, [locationSharing, locationSharingLoaded]);

  useEffect(() => {
    try {
      const storedMemories = localStorage.getItem(MEMORY_STORAGE_KEY);
      if (storedMemories) {
        const parsedMemories = JSON.parse(storedMemories);
        if (Array.isArray(parsedMemories)) {
          setSavedMemories(
            parsedMemories
              .map((entry, index) => {
                if (typeof entry === 'string') {
                  return { id: `memory-${index}`, text: entry };
                }
                if (entry && typeof entry.text === 'string') {
                  return { id: String(entry.id ?? `memory-${index}`), text: entry.text };
                }
                return null;
              })
              .filter(Boolean)
          );
        }
      }
    } catch (error) {
      console.warn('[Learning] Could not load saved memories:', error);
    } finally {
      setMemoriesLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setActiveSection(null);
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [menuOpen]);

  // ابدأ AudioFlow عند تحميل المكوّن
  useEffect(() => {
    let audioFlow = null;

    const initAudioFlow = async () => {
      audioFlow = new AudioFlowManager({
        onStateChange: (state) => {
          console.log('[Page] Audio state:', state);
          setOrbState(state);
        },
        onReply: (text) => {
          setReply(text);
        },
      });

      const started = await audioFlow.start();
      if (!started) {
        console.error('Failed to start audio flow');
        setOrbState('error');
      }

      audioFlowRef.current = audioFlow;
    };

    initAudioFlow();

    return () => {
      if (audioFlowRef.current) {
        audioFlowRef.current.stop();
      }
    };
  }, []);

  // عند المغادرة، تنظيف الموارد
  useEffect(() => {
    const cleanup = () => {
      if (audioFlowRef.current) {
        audioFlowRef.current.stop();
      }
    };

    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
      cleanup();
    };
  }, []);

  async function sendMessage(text) {
    if (!text.trim()) return;
    setLoading(true);
    setReply('');
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      setReply(data.reply || 'حدث خطأ، حاول مجددًا.');
    } catch (err) {
      setReply('تعذر الاتصال بالمساعد الآن.');
    } finally {
      setLoading(false);
    }
  }

  async function deleteLocalUserData() {
    setPrivacyMessage('');
    try {
      await clearAllMessages();
      localStorage.removeItem(PROFILE_STORAGE_KEY);
      localStorage.removeItem(PRIVACY_STORAGE_KEY);
      skipProfileSaveRef.current = true;
      setProfile({ ...DEFAULT_PROFILE });
      setPrivacyEnabled(true);
      setDeleteConfirmationOpen(false);
      setPrivacyMessage('تم حذف بياناتك المحلية المحددة.');
    } catch (error) {
      console.error('[Privacy] Could not delete local user data:', error);
      setPrivacyMessage('تعذر إكمال الحذف. قد تكون بعض البيانات قد حُذفت؛ حاول مرة أخرى.');
    }
  }

  function deleteSavedMemory(memoryId) {
    const remainingMemories = savedMemories.filter((memory) => memory.id !== memoryId);
    setSavedMemories(remainingMemories);
    try {
      if (remainingMemories.length) {
        localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(remainingMemories));
      } else {
        localStorage.removeItem(MEMORY_STORAGE_KEY);
      }
    } catch (error) {
      console.error('[Learning] Could not delete saved memory:', error);
      setSavedMemories(savedMemories);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div
        className="w-full transition-all duration-300"
        style={{ maxWidth: panelMaxWidth }}
      >
        <div className="bg-base-panel rounded-2xl border border-base-border overflow-hidden flex flex-col min-h-[420px]">
          {/* الشريط العلوي */}
          <div className="flex items-center justify-between px-4 py-3">
            <button
              type="button"
              aria-label="القائمة"
              aria-expanded={menuOpen}
              aria-controls="smart-menu"
              onClick={() => {
                setActiveSection(null);
                setMenuOpen(true);
              }}
              className="text-text-secondary"
            >
              ☰
            </button>
            <span className="text-xs text-text-secondary">
              {loading ? 'جاري التفكير...' : 'يستمع الآن'}
            </span>
            <button
              aria-label={expanded ? 'تصغير الشاشة' : 'توسيع الشاشة'}
              onClick={() => setExpanded((e) => !e)}
              className="text-text-secondary"
            >
              {expanded ? '⤡' : '⤢'}
            </button>
          </div>

          {/* الكرة والترحيب */}
          <div className="flex-1 flex flex-col items-center justify-center px-6 py-6">
            <AssistantOrb size={orbSize} state={orbState} />

            <p className="text-text-primary text-base font-medium mt-5">
              أهلًا بك
            </p>
            <p className="text-text-secondary text-xs mt-1 text-center">
              {reply || 'قل لي بماذا أساعدك'}
            </p>
          </div>

          {/* شريط الإدخال */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(message);
              setMessage('');
            }}
            className="flex items-center gap-2 px-4 py-3 border-t border-base-border"
          >
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="اسأل المساعد أي شيء"
              className="flex-1 bg-base-card border border-base-border text-text-primary rounded-lg h-10 px-3 text-sm text-right"
            />
            <button
              type="submit"
              className="w-10 h-10 rounded-full bg-gold flex items-center justify-center flex-shrink-0"
              aria-label="إرسال"
            >
              ➤
            </button>
          </form>
        </div>
      </div>

      {menuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
          onClick={() => {
            setMenuOpen(false);
            setActiveSection(null);
          }}
        >
          <aside
            id="smart-menu"
            role="dialog"
            aria-modal="true"
            aria-label="قائمة Smart.z"
            onClick={(event) => event.stopPropagation()}
            className="absolute right-0 top-0 flex h-[100dvh] w-[min(88vw,380px)] flex-col border-l border-base-border bg-base-panel shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-base-border px-5 py-4">
              {activeSection ? (
                <button
                  type="button"
                  onClick={() => setActiveSection(null)}
                  className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary"
                >
                  <span aria-hidden="true">→</span>
                  <span>القائمة</span>
                </button>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-gold">Smart.z</p>
                  <p className="mt-1 text-xs text-text-secondary">القائمة الرئيسية</p>
                </div>
              )}
              <button
                type="button"
                aria-label="إغلاق القائمة"
                onClick={() => {
                  setMenuOpen(false);
                  setActiveSection(null);
                }}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-xl text-text-secondary hover:bg-base-card hover:text-text-primary"
              >
                ×
              </button>
            </div>

            {activeSection ? (
              <div className="flex-1 overflow-y-auto px-5 py-6">
                {activeSection === 'profile' ? (
                  <div className="space-y-7">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">ملفي</h2>
                      <p className="mt-1 text-xs text-text-secondary">تُحفظ هذه البيانات على هذا الجهاز فقط.</p>
                    </div>

                    <label className="block space-y-2">
                      <span className="text-sm text-text-primary">الاسم</span>
                      <input
                        type="text"
                        value={profile.name}
                        onChange={(event) => setProfile((current) => ({ ...current, name: event.target.value }))}
                        placeholder="اكتب اسمك"
                        autoComplete="name"
                        className="h-11 w-full rounded-lg border border-base-border bg-base-card px-3 text-right text-sm text-text-primary placeholder:text-text-secondary focus:border-gold"
                      />
                    </label>

                    <fieldset className="space-y-3">
                      <legend className="text-sm text-text-primary">أسلوب الرد</legend>
                      <div className="grid grid-cols-3 gap-2" role="group" aria-label="أسلوب الرد">
                        {[
                          { value: 'short', label: 'مختصر' },
                          { value: 'medium', label: 'متوسط' },
                          { value: 'detailed', label: 'مفصل' },
                        ].map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={profile.responseStyle === option.value}
                            onClick={() => setProfile((current) => ({ ...current, responseStyle: option.value }))}
                            className={`min-h-10 rounded-lg border px-2 text-xs transition-colors ${
                              profile.responseStyle === option.value
                                ? 'border-gold/60 bg-gold/10 text-gold'
                                : 'border-base-border bg-base-card text-text-secondary hover:text-text-primary'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset className="space-y-3">
                      <legend className="text-sm text-text-primary">لغة المحادثة</legend>
                      <div className="grid grid-cols-2 gap-2" role="group" aria-label="لغة المحادثة">
                        {[
                          { value: 'ar', label: 'العربية' },
                          { value: 'en', label: 'الإنجليزية' },
                        ].map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={profile.language === option.value}
                            onClick={() => setProfile((current) => ({ ...current, language: option.value }))}
                            className={`min-h-10 rounded-lg border px-3 text-sm transition-colors ${
                              profile.language === option.value
                                ? 'border-gold/60 bg-gold/10 text-gold'
                                : 'border-base-border bg-base-card text-text-secondary hover:text-text-primary'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                  </div>
                ) : activeSection === 'apps' ? (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">ربط التطبيقات</h2>
                      <p className="mt-1 text-xs text-text-secondary">اختر التطبيقات التي ترغب بإضافتها.</p>
                    </div>

                    <div className="space-y-2">
                      <ul className="space-y-2">
                        <li className="flex min-h-16 items-center gap-3 rounded-lg border border-base-border bg-base-card px-3 py-3">
                          <span className="flex w-7 justify-center" aria-hidden="true">
                            <span className="h-3 w-3 rounded-full border border-gold/45 bg-gold/20 shadow-[inset_0_0_5px_rgba(201,168,104,0.18)]" />
                          </span>
                          <span className="min-w-0 flex-1 text-sm text-text-primary">WhatsApp</span>
                          <button
                            type="button"
                            disabled
                            className="min-h-9 min-w-16 rounded-lg border border-base-border px-3 text-xs text-text-secondary opacity-70"
                          >
                            ربط
                          </button>
                        </li>
                        {selectedApps.map((appId) => {
                          const app = SUPPORTED_APPS.find((supportedApp) => supportedApp.id === appId);
                          if (!app || appId === 'whatsapp') return null;
                          return (
                            <li key={app.id} className="flex min-h-16 items-center gap-3 rounded-lg border border-base-border bg-base-card px-3 py-3">
                              <span className="flex w-7 justify-center" aria-hidden="true">
                                <span className="h-3 w-3 rounded-full border border-gold/45 bg-gold/20 shadow-[inset_0_0_5px_rgba(201,168,104,0.18)]" />
                              </span>
                              <span className="min-w-0 flex-1 text-sm text-text-primary">{app.name}</span>
                              <span className="text-xs text-text-secondary">غير مرتبط</span>
                            </li>
                          );
                        })}
                      </ul>

                      <button
                        type="button"
                        aria-expanded={appPickerOpen}
                        aria-controls="supported-app-picker"
                        onClick={() => setAppPickerOpen((open) => !open)}
                        className="min-h-10 w-full rounded-lg border border-base-border px-3 text-sm text-text-secondary hover:bg-base-card hover:text-text-primary"
                      >
                        + إضافة تطبيق
                      </button>
                    </div>

                    {appPickerOpen && (
                      <div id="supported-app-picker" className="space-y-3 rounded-lg border border-base-border bg-base-card p-3">
                        <h3 className="text-sm font-medium text-text-primary">التطبيقات المدعومة</h3>
                        <ul className="space-y-1">
                          {SUPPORTED_APPS.map((app) => {
                            const isAdded = app.id === 'whatsapp' || selectedApps.includes(app.id);
                            return (
                              <li key={app.id}>
                                <button
                                  type="button"
                                  disabled={isAdded}
                                  onClick={() => setSelectedApps((current) => [...current, app.id])}
                                  className="flex min-h-10 w-full items-center gap-3 rounded-md px-2 text-right text-sm text-text-primary hover:bg-base-panel disabled:text-text-secondary"
                                >
                                  <span className="flex w-6 justify-center" aria-hidden="true">
                                    <span className="h-2.5 w-2.5 rounded-full border border-gold/45 bg-gold/20" />
                                  </span>
                                  <span className="flex-1">{app.name}</span>
                                  {isAdded && <span className="text-xs text-text-secondary">مضاف</span>}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    <aside className="rounded-lg border border-gold/20 bg-gold/5 p-3 text-xs leading-5 text-text-secondary">
                      <p className="font-medium text-text-primary">قبل ربط أي تطبيق</p>
                      <p className="mt-1">قد يطلب التطبيق صلاحيات للوصول إلى بياناتك. راجع الصلاحيات والبيانات التي ستتم مشاركتها، واسأل عن استخدامها في الذاكرة قبل الموافقة.</p>
                      <p className="mt-2 text-gold/80">هذه لوحة اختيار فقط؛ لا يبدأ الربط ولا تُرسل بيانات أو طلبات حاليًا.</p>
                    </aside>
                  </div>
                ) : activeSection === 'learning' ? (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">التعلم والتخصيص</h2>
                      <p className="mt-1 text-xs text-text-secondary">الذاكرة المحفوظة على هذا الجهاز.</p>
                    </div>

                    {!memoriesLoaded ? (
                      <p className="text-sm text-text-secondary">جارٍ تحميل الذاكرة...</p>
                    ) : savedMemories.length === 0 ? (
                      <p className="rounded-lg border border-base-border bg-base-card px-4 py-5 text-sm text-text-secondary">
                        لا توجد ذاكرة محفوظة حاليًا.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {savedMemories.map((memory) => (
                          <li
                            key={memory.id}
                            className="flex items-start gap-3 rounded-lg border border-base-border bg-base-card p-3"
                          >
                            <span className="mt-1.5 flex w-5 justify-center" aria-hidden="true">
                              <span className="h-2.5 w-2.5 rounded-full border border-gold/45 bg-gold/20" />
                            </span>
                            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-text-primary">
                              {memory.text}
                            </p>
                            <button
                              type="button"
                              onClick={() => deleteSavedMemory(memory.id)}
                              className="shrink-0 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-base-panel hover:text-red-300"
                              aria-label={`حذف الذاكرة: ${memory.text}`}
                            >
                              حذف
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : activeSection === 'privacy' ? (
                  <div className="space-y-7">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">الخصوصية والبيانات</h2>
                      <p className="mt-1 text-xs text-text-secondary">إعداد محفوظ على هذا الجهاز فقط.</p>
                    </div>

                    <div className="flex min-h-12 items-center gap-3 rounded-lg border border-base-border bg-base-card px-3">
                      <span className="flex w-7 justify-center" aria-hidden="true">
                        <span className="h-3 w-3 rounded-full border border-gold/45 bg-gold/20 shadow-[inset_0_0_5px_rgba(201,168,104,0.18)]" />
                      </span>
                      <span className="text-sm text-text-primary">الخصوصية والبيانات</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={privacyEnabled}
                        aria-label="الخصوصية والبيانات"
                        onClick={() => setPrivacyEnabled((enabled) => !enabled)}
                        className={`mr-auto flex h-8 min-w-[76px] items-center justify-between rounded-full border px-2 text-xs transition-colors ${
                          privacyEnabled
                            ? 'border-gold/60 bg-gold/10 text-gold'
                            : 'border-base-border bg-base-panel text-text-secondary'
                        }`}
                      >
                        <span>{privacyEnabled ? 'نعم' : 'لا'}</span>
                        <span
                          aria-hidden="true"
                          className={`h-2.5 w-2.5 rounded-full ${privacyEnabled ? 'bg-gold/70' : 'bg-text-secondary'}`}
                        />
                      </button>
                    </div>

                    <div className="space-y-3 border-t border-base-border pt-6">
                      <div>
                        <h3 className="text-sm font-medium text-text-primary">حذف البيانات</h3>
                        <p className="mt-1 text-xs leading-5 text-text-secondary">
                          يحذف الاسم والتفضيلات وسجل المحادثة المحفوظ محليًا على هذا الجهاز فقط.
                        </p>
                      </div>
                      {!deleteConfirmationOpen ? (
                        <button
                          type="button"
                          onClick={() => {
                            setPrivacyMessage('');
                            setDeleteConfirmationOpen(true);
                          }}
                          className="min-h-10 rounded-lg border border-red-900/60 px-4 text-sm text-red-300 hover:bg-red-950/30"
                        >
                          حذف
                        </button>
                      ) : (
                        <div className="space-y-3 rounded-lg border border-base-border bg-base-card p-4" role="alertdialog" aria-label="تأكيد حذف البيانات">
                          <p className="text-sm leading-6 text-text-primary">
                            هل تريد حذف الاسم والتفضيلات وسجل المحادثة من هذا الجهاز؟ لا يمكن التراجع عن هذا الإجراء.
                          </p>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={deleteLocalUserData}
                              className="min-h-10 rounded-lg border border-red-900/60 px-4 text-sm text-red-300 hover:bg-red-950/30"
                            >
                              تأكيد الحذف
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmationOpen(false)}
                              className="min-h-10 rounded-lg border border-base-border px-4 text-sm text-text-secondary hover:text-text-primary"
                            >
                              إلغاء
                            </button>
                          </div>
                        </div>
                      )}
                      {privacyMessage && (
                        <p role="status" className="text-xs text-text-secondary">{privacyMessage}</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <h2 className="text-base font-semibold text-text-primary">
                    {MENU_SECTIONS.find((section) => section.id === activeSection)?.label}
                  </h2>
                )}
              </div>
            ) : (
              <nav aria-label="أقسام Smart.z" className="flex-1 overflow-y-auto px-3 py-3">
                <ul className="space-y-1">
                  {MENU_SECTIONS.slice(0, 3).map((section) => (
                    <li key={section.id}>
                      <button
                        type="button"
                        onClick={() => setActiveSection(section.id)}
                        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-right text-sm text-text-primary transition-colors hover:bg-base-card"
                      >
                        <span className="flex w-7 justify-center" aria-hidden="true">
                          <span className="h-3 w-3 rounded-full border border-gold/45 bg-gold/20 shadow-[inset_0_0_5px_rgba(201,168,104,0.18)]" />
                        </span>
                        <span>{section.label}</span>
                        <span className="mr-auto text-text-secondary" aria-hidden="true">‹</span>
                      </button>
                    </li>
                  ))}
                  <li>
                    <div className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-sm text-text-primary">
                      <span className="flex w-7 justify-center" aria-hidden="true">
                        <span className="h-3 w-3 rounded-full border border-gold/45 bg-gold/20 shadow-[inset_0_0_5px_rgba(201,168,104,0.18)]" />
                      </span>
                      <span>مشاركة الموقع</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={locationSharing}
                        aria-label="مشاركة الموقع"
                        onClick={() => setLocationSharing((sharing) => !sharing)}
                        className={`mr-auto flex h-8 min-w-[76px] items-center justify-between rounded-full border px-2 text-xs transition-colors ${
                          locationSharing
                            ? 'border-gold bg-gold/15 text-gold'
                            : 'border-base-border bg-base-card text-text-secondary'
                        }`}
                      >
                        <span>{locationSharing ? 'نعم' : 'لا'}</span>
                        <span
                          aria-hidden="true"
                          className={`h-2.5 w-2.5 rounded-full ${locationSharing ? 'bg-gold' : 'bg-text-secondary'}`}
                        />
                      </button>
                    </div>
                  </li>
                  {MENU_SECTIONS.slice(3).map((section) => (
                    <li key={section.id}>
                      <button
                        type="button"
                        onClick={() => setActiveSection(section.id)}
                        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-right text-sm text-text-primary transition-colors hover:bg-base-card"
                      >
                        <span className="flex w-7 justify-center" aria-hidden="true">
                          <span className="h-3 w-3 rounded-full border border-gold/45 bg-gold/20 shadow-[inset_0_0_5px_rgba(201,168,104,0.18)]" />
                        </span>
                        <span>{section.label}</span>
                        <span className="mr-auto text-text-secondary" aria-hidden="true">‹</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}

            <footer className="mt-auto border-t border-base-border px-5 py-4 text-center text-xs text-text-secondary">
              Smart.z · الإصدار 0.1.0
            </footer>
          </aside>
        </div>
      )}
    </main>
  );
}
