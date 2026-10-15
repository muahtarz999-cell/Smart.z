'use client';

import { useEffect, useRef, useState } from 'react';
import AssistantOrb from '../components/AssistantOrb';
import VoiceWave from '../components/VoiceWave';
import LocalDataPanel from '../components/LocalDataPanel';
import WhatsAppClusterConnection from '../components/WhatsAppClusterConnection';
import PermissionsSetup, { readSetupState } from '../components/PermissionsSetup';
import LearningPanel from '../components/LearningPanel';
import { getAssistantContext, learnFromRecentConversation } from '../lib/learning';
import { AudioFlowManager } from '../lib/audio-flow';
import {
  openInstalledApp,
  openTweetComposer,
  openWhatsAppChat,
} from '../lib/native-apps';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import {
  clearAllLocalData,
  deleteLocalRecord,
  listLocalRecords,
  migrateLegacyMemories,
  saveLocalRecord,
} from '../lib/local-data';
import {
  canOpenSpeechEngineSettings,
  getArabicVoiceInfo,
  getSpeechDiagnostics,
  isSpeechSupported,
  openSpeechEngineSettings,
  preloadArabicVoice,
  testSpeechPlayback,
} from '../lib/tts';
import { configureSpeech, primeSpeech } from '../lib/speech';
import VoiceSettings from '../components/VoiceSettings';
import SendActionBanner from '../components/SendActionBanner';
import SendSettings from '../components/SendSettings';
import { cancelPendingSend, configureSendActions, isCancelCommand, queueSend } from '../lib/send-actions';
import { prepareCustomerLocalData } from '../lib/customer-local-data';
import {
  getTaskReminderStatus,
  synchronizeTaskReminders,
} from '../lib/task-notifications';

const MENU_SECTIONS = [
  { id: 'profile', label: 'ملفي' },
  { id: 'learning', label: 'التعلم والتخصيص' },
  { id: 'notes', label: 'ملاحظاتي' },
  { id: 'tasks', label: 'مهامي' },
  { id: 'audio', label: 'الصوت' },
  { id: 'apps', label: 'ربط التطبيقات' },
  { id: 'privacy', label: 'الخصوصية والبيانات' },
];

const PROFILE_STORAGE_KEY = 'smart-assistant-profile';
const MEMORY_STORAGE_KEY = 'smart-assistant-memories';
const DEFAULT_PROFILE = {
  name: '',
  responseStyle: 'medium',
  language: 'ar',
};

let metaSdkPromise = null;

function loadMetaSdk(appId) {
  if (typeof window.FB !== 'undefined') {
    if (window.__smartMetaSdkAppId !== appId) {
      window.FB.init({ appId, cookie: true, xfbml: false });
      window.__smartMetaSdkAppId = appId;
    }
    return Promise.resolve(window.FB);
  }

  if (!metaSdkPromise) {
    metaSdkPromise = new Promise((resolve, reject) => {
      window.fbAsyncInit = () => {
        window.FB.init({ appId, cookie: true, xfbml: false });
        window.__smartMetaSdkAppId = appId;
        resolve(window.FB);
      };

      const script = document.createElement('script');
      script.async = true;
      script.defer = true;
      script.crossOrigin = 'anonymous';
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.onerror = () => {
        metaSdkPromise = null;
        reject(new Error('تعذر تحميل مكتبة Meta.'));
      };
      document.head.appendChild(script);
    });
  }

  return metaSdkPromise;
}

export default function Home() {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState(null);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileSaveNotice, setProfileSaveNotice] = useState('');
  const [savedMemories, setSavedMemories] = useState([]);
  const [memoriesLoaded, setMemoriesLoaded] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [privacyMessage, setPrivacyMessage] = useState('');
  const [authUser, setAuthUser] = useState(null);
  const [authSession, setAuthSession] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [customerAccess, setCustomerAccess] = useState({ status: 'checking', message: '' });
  const [localStorageStatus, setLocalStorageStatus] = useState({
    persistent: false,
    persistenceSupported: false,
  });
  const [authPanelOpen, setAuthPanelOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [whatsappBusy, setWhatsappBusy] = useState(false);
  const [whatsappConnectionLoading, setWhatsappConnectionLoading] = useState(false);
  const [whatsappError, setWhatsappError] = useState('');
  const [whatsappMetaConnection, setWhatsappMetaConnection] = useState(null);
  const [externalAppMessage, setExternalAppMessage] = useState('');
  const [whatsappDraftPhone, setWhatsappDraftPhone] = useState('');
  const [whatsappDraftText, setWhatsappDraftText] = useState('');
  const [tweetDraftText, setTweetDraftText] = useState('');
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);
  const [audioSettingsMessage, setAudioSettingsMessage] = useState('');
  const [audioPreviewing, setAudioPreviewing] = useState(false);
  const [audioSupported, setAudioSupported] = useState(true);
  const [audioVoiceInfo, setAudioVoiceInfo] = useState(null);
  const [audioVoiceError, setAudioVoiceError] = useState('');
  const [audioDiagnostics, setAudioDiagnostics] = useState(null);
  const [audioDiagnosticsLoading, setAudioDiagnosticsLoading] = useState(false);
  const [audioPlaybackError, setAudioPlaybackError] = useState('');
  const [audioSetupOpening, setAudioSetupOpening] = useState(false);
  const [taskNotificationStatus, setTaskNotificationStatus] = useState(null);
  const [orbState, setOrbState] = useState('ready');
  const [lastTranscript, setLastTranscript] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [learningVersion, setLearningVersion] = useState(0);
  const audioFlowRef = useRef(null);
  const pressStartedAtRef = useRef(0);
  const micLevelRef = useRef(0); // written by the recorder ~10x/s, read by the wave without re-rendering
  const profileRef = useRef(DEFAULT_PROFILE);
  const [customerDataUserId, setCustomerDataUserId] = useState(null);
  const skipProfileSaveRef = useRef(false);
  const profileEditPendingRef = useRef(false);

  const customerDataReady = Boolean(authUser?.id && customerDataUserId === authUser.id);
  const orbSize = expanded ? 190 : 128;
  // During a conversation the orb becomes a vibrating line and the text gets the space.
  const conversationActive = Boolean(reply || lastTranscript || loading)
    || ['preparing', 'listening', 'transcribing', 'thinking', 'speaking'].includes(orbState);
  const panelMaxWidth = conversationActive ? 480 : expanded ? 420 : 340;

  useEffect(() => {
    let active = true;
    let checking = false;

    const refreshTaskNotifications = async () => {
      if (checking) return;
      checking = true;
      try {
        const status = await getTaskReminderStatus();
        if (active) setTaskNotificationStatus(status);
        if (
          customerDataReady
          && status.supported
          && status.permission === 'granted'
          && status.channelEnabled
        ) {
          const tasks = await listLocalRecords('tasks');
          await synchronizeTaskReminders(tasks);
        }
      } catch (error) {
        console.error('[Notifications] Could not refresh local task reminders:', error);
        if (active) {
          setTaskNotificationStatus({
            supported: true,
            permission: 'error',
            channelEnabled: false,
            error: error?.message || 'تعذر فحص حالة الإشعارات.',
          });
        }
      } finally {
        checking = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshTaskNotifications();
    };

    refreshTaskNotifications();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [customerDataReady]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setAuthReady(true);
      return undefined;
    }

    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => {
        if (active) {
          setAuthUser(session?.user ?? null);
          setAuthSession(session);
          setAuthReady(true);
        }
      }, 0);
    });

    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setAuthError('تعذر استعادة جلسة المستخدم.');
      setAuthUser(data.session?.user ?? null);
      setAuthSession(data.session ?? null);
      setAuthReady(true);
    }).catch(() => {
      if (!active) return;
      setAuthError('تعذر استعادة جلسة المستخدم.');
      setAuthSession(null);
      setAuthReady(true);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authReady) return undefined;
    let active = true;
    setWhatsappMetaConnection(null);
    setWhatsappError('');

    if (!authUser || !authSession?.access_token) {
      setWhatsappConnectionLoading(false);
      setCustomerAccess({ status: 'unauthenticated', message: 'سجّل الدخول للمتابعة.' });
      return () => { active = false; };
    }

    setCustomerAccess({ status: 'checking', message: 'جارٍ التحقق من أهلية الحساب...' });
    const verifyAccess = async () => {
      const headers = {
        Authorization: `Bearer ${authSession.access_token}`,
      };
      try {
        const response = await fetch('/api/auth/access', { headers, cache: 'no-store' });
        const result = await response.json();
        if (!active) return;
        if (response.ok && result.active === true && result.user?.id === authUser.id) {
          const localWorkspace = await prepareCustomerLocalData(authUser.id);
          if (!active) return;
          setLocalStorageStatus({
            persistent: localWorkspace.persistent,
            persistenceSupported: localWorkspace.persistenceSupported,
          });
          if (localWorkspace.changed) {
            setProfile({ ...DEFAULT_PROFILE });
            setProfileLoaded(false);
            setSavedMemories([]);
            setMemoriesLoaded(false);
          }
          setCustomerDataUserId(authUser.id);
          setCustomerAccess({ status: 'active', message: '' });
        } else {
          setCustomerAccess({
            status: 'denied',
            message: result.message || 'تعذر التحقق من أهلية الحساب.',
          });
        }
      } catch (error) {
        console.error('[Customer access] Access verification failed:', error);
        if (active) setCustomerAccess({ status: 'error', message: 'تعذر التحقق من أهلية الحساب أو تجهيز بياناته المحلية.' });
      }
    };

    verifyAccess();

    return () => { active = false; };
  }, [authReady, authUser?.id, authSession?.access_token]);

  useEffect(() => {
    if (customerAccess.status !== 'active' || !authSession?.access_token) {
      setWhatsappConnectionLoading(false);
      return undefined;
    }
    let active = true;
    setWhatsappMetaConnection(null);
    setWhatsappConnectionLoading(true);

    fetch('/api/whatsapp/connection', {
      headers: { Authorization: `Bearer ${authSession.access_token}` },
      cache: 'no-store',
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || 'تعذر جلب حالة ربط WhatsApp.');
        if (active) {
          setWhatsappMetaConnection(result.connection || null);
          setWhatsappError('');
        }
      })
      .catch((error) => {
        if (active) setWhatsappError(error?.message || 'تعذر جلب حالة ربط WhatsApp.');
      })
      .finally(() => {
        if (active) setWhatsappConnectionLoading(false);
      });

    return () => { active = false; };
  }, [customerAccess.status, authSession?.access_token]);

  useEffect(() => {
    if (!customerDataReady) return undefined;
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
  }, [customerDataReady]);

  useEffect(() => {
    if (!customerDataReady || !profileLoaded) return;
    if (skipProfileSaveRef.current) {
      skipProfileSaveRef.current = false;
      return;
    }
    const shouldShowSaveNotice = profileEditPendingRef.current;
    profileEditPendingRef.current = false;
    try {
      localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
      if (shouldShowSaveNotice) {
        setProfileSaveNotice('تم حفظ الإعدادات على هذا الجهاز.');
      }
    } catch (error) {
      console.warn('[Profile] Could not save profile locally:', error);
      if (shouldShowSaveNotice) {
        setProfileSaveNotice('تعذر حفظ الإعدادات على هذا الجهاز.');
      }
    }
  }, [customerDataReady, profile, profileLoaded]);

  useEffect(() => {
    if (!customerDataReady) return undefined;
    let active = true;
    migrateLegacyMemories(MEMORY_STORAGE_KEY)
      .then(() => listLocalRecords('memories'))
      .then((memories) => {
        if (active) setSavedMemories(memories);
      })
      .catch((error) => {
        console.error('[Learning] Could not load saved memories:', error);
        if (active) setMemoryError('تعذر تحميل الذكريات المحلية. لم يتم حذف البيانات القديمة.');
      })
      .finally(() => {
        if (active) setMemoriesLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [customerDataReady]);

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

  useEffect(() => {
    if (activeSection !== 'audio') return undefined;
    let active = true;
    const refreshVoices = () => {
      setAudioSupported(isSpeechSupported());
      setAudioVoiceInfo(null);
      setAudioVoiceError('');
      setAudioDiagnosticsLoading(true);
      getSpeechDiagnostics()
        .then((diagnostics) => {
          if (active) setAudioDiagnostics(diagnostics);
        })
        .catch((error) => {
          console.error('[TTS] Could not collect speech diagnostics:', error);
          if (active) {
            setAudioDiagnostics({
              error: error?.message || 'تعذر جمع معلومات تشخيص محركات النطق.',
            });
          }
        })
        .finally(() => {
          if (active) setAudioDiagnosticsLoading(false);
        });
      getArabicVoiceInfo()
        .then((voiceInfo) => {
          if (active) setAudioVoiceInfo(voiceInfo);
        })
        .catch((error) => {
          console.error('[TTS] Could not find an Arabic voice:', error);
          if (active) setAudioVoiceError(error?.message || 'تعذر العثور على صوت عربي في هذا الجهاز.');
        });
    };
    const refreshOnResume = () => {
      if (document.visibilityState === 'visible') refreshVoices();
    };

    refreshVoices();
    document.addEventListener('visibilitychange', refreshOnResume);
    window.speechSynthesis?.addEventListener?.('voiceschanged', refreshVoices);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', refreshOnResume);
      window.speechSynthesis?.removeEventListener?.('voiceschanged', refreshVoices);
    };
  }, [activeSection]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  // Always a fresh token: the session refreshes hourly and a captured token goes stale.
  async function getAccessToken() {
    if (!supabase) return null;
    const { data, error } = await supabase.auth.getSession();
    return error ? null : data.session?.access_token ?? null;
  }

  // First run on this device: ask for permissions and prove the voice plays.
  useEffect(() => {
    if (!customerDataReady) return;
    if (!readSetupState()) setSetupOpen(true);
    void preloadArabicVoice();
  }, [customerDataReady]);

  useEffect(() => {
    if (customerAccess.status !== 'active' || !authUser) return undefined;

    configureSpeech({ getAccessToken });
    configureSendActions({
      getAccessToken,
      onResult: (result) => {
        if (!result.ok) setAudioPlaybackError(result.error?.message || result.data?.error || 'تعذر إرسال رسالة واتساب.');
      },
    });
    const audioFlow = new AudioFlowManager({
      getAccessToken,
      getPreferences: () => ({
        responseStyle: profileRef.current.responseStyle,
        language: profileRef.current.language,
      }),
      getContext: getAssistantContext,
      onAction: queueSend,
      interceptTranscript: (text) => {
        if (isCancelCommand(text) && cancelPendingSend()) {
          setReply('ألغيت الإرسال.');
          return true;
        }
        return false;
      },
      onTurnComplete: () => {
        // Runs in the background; learning must never slow down or break a conversation.
        learnFromRecentConversation({ getAccessToken })
          .then((profile) => { if (profile) setLearningVersion((v) => v + 1); })
          .catch((error) => console.warn('[Learning]', error?.message));
      },
      onStateChange: (state) => setOrbState(state),
      onLevel: (level) => { micLevelRef.current = level; },
      onTranscript: (text) => setLastTranscript(text),
      onReply: (text) => {
        setReply(text);
        setAudioPlaybackError('');
      },
      onError: (error) => {
        console.error('[Voice]', error);
        setAudioPlaybackError(error?.message || 'حدث خطأ في المحادثة الصوتية.');
      },
    });
    audioFlowRef.current = audioFlow;

    return () => {
      audioFlow.destroy();
      if (audioFlowRef.current === audioFlow) audioFlowRef.current = null;
    };
  }, [customerAccess.status, authUser?.id]);

  // Talk button: a short tap starts recording and a second tap sends;
  // holding for more than 450 ms sends on release. No pointer capture: the
  // permission dialog steals the pointer and used to cancel the first press.
  function onTalkPress(event) {
    event.preventDefault();
    const audioFlow = audioFlowRef.current;
    if (!audioFlow) return;
    setAudioPlaybackError('');
    if (audioFlow.isRecording) {
      void audioFlow.endTurn();
      return;
    }
    if (audioFlow.isBusy) return;
    pressStartedAtRef.current = Date.now();
    void audioFlow.beginTurn(); // synchronous part runs inside the gesture
  }

  function onTalkRelease() {
    const audioFlow = audioFlowRef.current;
    if (!audioFlow?.isRecording || !pressStartedAtRef.current) return;
    const heldFor = Date.now() - pressStartedAtRef.current;
    pressStartedAtRef.current = 0;
    if (heldFor > 450) void audioFlow.endTurn();
  }

  // عند المغادرة، تنظيف الموارد
  useEffect(() => {
    const cleanup = () => {
      if (audioFlowRef.current) {
        audioFlowRef.current.destroy();
      }
    };

    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
      cleanup();
    };
  }, []);

  async function sendMessage(text) {
    const audioFlow = audioFlowRef.current;
    if (!text.trim() || customerAccess.status !== 'active' || !audioFlow) return;
    if (isCancelCommand(text) && cancelPendingSend()) {
      setReply('ألغيت الإرسال.');
      return;
    }
    setLoading(true);
    setReply('');
    setLastTranscript(text.trim());
    setAudioPlaybackError('');
    try {
      await audioFlow.respondTo(text.trim(), { channel: 'text' });
    } catch (error) {
      setReply('');
      setAudioPlaybackError(error?.message || 'تعذر الاتصال بالمساعد الآن.');
    } finally {
      setLoading(false);
    }
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (!supabase || authBusy) return;

    setAuthBusy(true);
    setAuthError('');
    setAuthNotice('');
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: authEmail.trim(),
        password: authPassword,
      });
      if (error) throw error;
      setAuthNotice('تم تسجيل الدخول بنجاح.');
      setAuthPassword('');
    } catch (error) {
      setAuthError(error?.message || 'تعذر إكمال عملية المصادقة.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!supabase || authBusy) return;
    setAuthBusy(true);
    setAuthError('');
    setAuthNotice('');
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setAuthPanelOpen(false);
      setAuthNotice('تم تسجيل الخروج.');
    } catch (error) {
      setAuthError(error?.message || 'تعذر تسجيل الخروج.');
    } finally {
      setAuthBusy(false);
    }
  }

  async function startOfficialWhatsAppSignup() {
    if (!authUser || !authSession?.access_token) {
      setWhatsappError('سجّل الدخول إلى Smart.z قبل ربط WhatsApp.');
      return;
    }
    if (whatsappMetaConnection && !window.confirm('سيتم استبدال رقم WhatsApp الحالي بعد نجاح التحقق من الرقم الجديد لدى Meta. هل تريد المتابعة؟')) {
      return;
    }

    setWhatsappBusy(true);
    setWhatsappError('');
    try {
      const startResponse = await fetch('/api/whatsapp/embedded-signup/start', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authSession.access_token}`,
        },
      });
      const config = await startResponse.json();
      if (!startResponse.ok) {
        if (config.code === 'META_SETUP_INCOMPLETE') {
          throw new Error('إعداد الربط الرسمي غير مكتمل حاليًا.');
        }
        throw new Error(config.message || 'تعذر بدء الربط الرسمي حاليًا.');
      }

      const facebook = await loadMetaSdk(config.appId);
      const result = await new Promise((resolve, reject) => {
        let authCode = null;
        let signupData = null;
        const timeout = window.setTimeout(() => finish(new Error('انتهت مهلة التسجيل لدى Meta.')), 120000);

        const finish = (error, value) => {
          window.clearTimeout(timeout);
          window.removeEventListener('message', onMetaMessage);
          if (error) reject(error);
          else resolve(value);
        };

        const onMetaMessage = (event) => {
          let payload = event.data;
          if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch { return; }
          }
          const host = (() => { try { return new URL(event.origin).hostname; } catch { return ''; } })();
          if (!host.endsWith('facebook.com') || payload?.type !== 'WA_EMBEDDED_SIGNUP') return;

          if (payload.event === 'CANCEL' || payload.event === 'ERROR') {
            finish(new Error('تم إلغاء تسجيل WhatsApp لدى Meta.'));
            return;
          }
          if (payload.event === 'FINISH') {
            signupData = payload.data || {};
            if (authCode && signupData.waba_id && signupData.phone_number_id) {
              finish(null, { code: authCode, wabaId: String(signupData.waba_id), phoneNumberId: String(signupData.phone_number_id) });
            }
          }
        };

        window.addEventListener('message', onMetaMessage);
        facebook.login((response) => {
          authCode = response?.authResponse?.code || null;
          if (!authCode && response?.status !== 'unknown') {
            finish(new Error('لم تُرجع Meta رمز التسجيل.'));
            return;
          }
          if (authCode && signupData?.waba_id && signupData?.phone_number_id) {
            finish(null, { code: authCode, wabaId: String(signupData.waba_id), phoneNumberId: String(signupData.phone_number_id) });
          }
        }, {
          config_id: config.configId,
          response_type: 'code',
          override_default_response_type: true,
          extras: { setup: {} },
        });
      });

      const callbackResponse = await fetch('/api/whatsapp/embedded-signup/callback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authSession.access_token}`,
        },
        body: JSON.stringify({ ...result, state: config.state }),
      });
      const callbackResult = await callbackResponse.json();
      if (!callbackResponse.ok) throw new Error(callbackResult.message || 'تعذر إكمال ربط WhatsApp.');
      setWhatsappMetaConnection(callbackResult.connection);
    } catch (error) {
      setWhatsappError(error?.message || 'تعذر بدء الربط الرسمي حاليًا.');
    } finally {
      setWhatsappBusy(false);
    }
  }

  async function deleteLocalUserData() {
    setPrivacyMessage('');
    try {
      await clearAllLocalData();
      localStorage.removeItem(PROFILE_STORAGE_KEY);
      localStorage.removeItem(MEMORY_STORAGE_KEY);
      localStorage.removeItem('smart-assistant-voice-id');
      skipProfileSaveRef.current = true;
      setProfile({ ...DEFAULT_PROFILE });
      setSavedMemories([]);
      setMemoryDraft('');
      setMemoryError('');
      setDeleteConfirmationOpen(false);
      setPrivacyMessage('تم حذف بياناتك المحلية المحددة.');
    } catch (error) {
      console.error('[Privacy] Could not delete local user data:', error);
      setPrivacyMessage('تعذر إكمال الحذف. قد تكون بعض البيانات قد حُذفت؛ حاول مرة أخرى.');
    }
  }

  async function saveMemory(event) {
    event.preventDefault();
    const text = memoryDraft.trim();
    if (!text) return;
    setMemoryError('');
    try {
      const memory = await saveLocalRecord('memories', { text });
      setSavedMemories((current) => [memory, ...current]);
      setMemoryDraft('');
    } catch (error) {
      console.error('[Learning] Could not save memory:', error);
      setMemoryError('تعذر حفظ الذاكرة على هذا الجهاز.');
    }
  }

  async function deleteSavedMemory(memoryId) {
    setMemoryError('');
    try {
      await deleteLocalRecord('memories', memoryId);
      setSavedMemories((current) => current.filter((memory) => memory.id !== memoryId));
    } catch (error) {
      console.error('[Learning] Could not delete saved memory:', error);
      setMemoryError('تعذر حذف الذاكرة من هذا الجهاز.');
    }
  }

  async function launchExternalApp(appId) {
    setExternalAppMessage('');
    try {
      await openInstalledApp(appId);
    } catch (error) {
      console.error('[Apps] Could not open the requested app:', error);
      setExternalAppMessage(error?.message || 'تعذر فتح التطبيق المطلوب.');
    }
  }

  async function launchWhatsAppDraft() {
    const phone = whatsappDraftPhone.replace(/\D/g, '');
    const text = whatsappDraftText.trim();
    if (!text || !window.confirm(
      `سيتم فتح WhatsApp بالرسالة التالية إلى ${phone || 'الرقم المحدد'}.\nلن تُرسل الرسالة إلا إذا ضغطت «إرسال» داخل WhatsApp.\n\n${text}`
    )) return;

    setExternalAppMessage('');
    try {
      await openWhatsAppChat(phone, text);
    } catch (error) {
      console.error('[Apps] Could not open WhatsApp message draft:', error);
      setExternalAppMessage(error?.message || 'تعذر فتح مسودة رسالة WhatsApp.');
    }
  }

  async function launchTweetDraft() {
    const text = tweetDraftText.trim();
    if (!text || !window.confirm(
      `سيتم فتح مسودة التغريدة في X. لن تُنشر إلا إذا ضغطت «نشر» داخل X.\n\n${text}`
    )) return;

    setExternalAppMessage('');
    try {
      await openTweetComposer(text);
    } catch (error) {
      console.error('[Apps] Could not open X post draft:', error);
      setExternalAppMessage(error?.message || 'تعذر فتح مسودة التغريدة.');
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      {setupOpen && customerDataReady && (
        <PermissionsSetup onDone={() => setSetupOpen(false)} onSkip={() => setSetupOpen(false)} />
      )}
      <div
        className="w-full min-w-0 transition-all duration-300"
        style={{ maxWidth: panelMaxWidth }}
      >
        <div className={`bg-base-panel rounded-2xl border border-base-border overflow-hidden flex flex-col transition-all duration-300 ${
          conversationActive ? 'h-[min(86dvh,720px)]' : 'min-h-[420px]'
        }`}>
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
              {customerAccess.status === 'checking'
                ? 'جارٍ التحقق من الحساب...'
                : customerAccess.status !== 'active'
                  ? 'يتطلب حسابًا مفعّلًا'
                  : ({
                    preparing: 'جارٍ فتح الميكروفون…',
                    listening: 'يستمع الآن',
                    transcribing: 'يحوّل كلامك إلى نص…',
                    thinking: 'يفكر…',
                    speaking: 'يتحدث',
                    error: 'حدث خطأ',
                  })[orbState] || (loading ? 'يفكر…' : 'جاهز')}
            </span>
            <button
              aria-label={expanded ? 'تصغير الشاشة' : 'توسيع الشاشة'}
              onClick={() => setExpanded((e) => !e)}
              className="text-text-secondary"
            >
              {expanded ? '⤡' : '⤢'}
            </button>
          </div>

          {customerAccess.status === 'active' ? (
            <>
              {conversationActive ? (
                // Conversation: a vibrating line on top, the words get the rest of the space.
                <div className="flex min-h-0 flex-1 flex-col px-5 pt-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <VoiceWave state={orbState} levelRef={micLevelRef} height={48} />
                    </div>
                    <button
                      type="button"
                      onClick={() => { audioFlowRef.current?.cancelTurn(); setReply(''); setLastTranscript(''); setAudioPlaybackError(''); }}
                      className="shrink-0 rounded-md px-2 py-1 text-[11px] text-text-secondary hover:bg-base-card hover:text-text-primary"
                    >
                      محادثة جديدة
                    </button>
                  </div>

                  <div className="mt-2 min-h-0 flex-1 space-y-4 overflow-y-auto pb-3">
                    {lastTranscript && (
                      <p className="mr-auto max-w-[85%] rounded-2xl rounded-tl-sm bg-base-card px-4 py-2 text-sm leading-7 text-text-secondary" dir="auto">
                        {lastTranscript}
                      </p>
                    )}
                    {reply ? (
                      <p className="whitespace-pre-line text-[17px] leading-8 text-text-primary" dir="auto">{reply}</p>
                    ) : (
                      <p className="text-sm leading-7 text-text-secondary">
                        {({
                          preparing: 'جارٍ فتح الميكروفون…',
                          listening: 'أسمعك… اضغط «إرسال» عند الانتهاء',
                          transcribing: 'أكتب ما قلته…',
                          thinking: 'أفكر في الرد…',
                        })[orbState] || (loading ? 'أفكر في الرد…' : '')}
                      </p>
                    )}
                    {audioPlaybackError && (
                      <p role="status" className="text-xs leading-5 text-amber-300">{audioPlaybackError}</p>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center px-6 py-6">
                  <AssistantOrb size={orbSize} />
                  <p className="text-text-primary text-base font-medium mt-5">أهلًا بك</p>
                  <p className="text-text-secondary text-xs mt-1 text-center">اضغط الزر وتحدث، أو اكتب سؤالك</p>
                  {audioPlaybackError && (
                    <p role="status" className="mt-2 max-w-xs text-center text-xs leading-5 text-amber-300">{audioPlaybackError}</p>
                  )}
                </div>
              )}

              <div className="flex flex-col items-center px-6 pb-3">
                <button
                  type="button"
                  onPointerDown={onTalkPress}
                  onPointerUp={onTalkRelease}
                  onContextMenu={(event) => event.preventDefault()}
                  onKeyDown={(event) => {
                    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) onTalkPress(event);
                  }}
                  disabled={orbState === 'transcribing' || orbState === 'thinking' || orbState === 'preparing'}
                  aria-pressed={orbState === 'listening'}
                  className={`${conversationActive ? 'mt-1' : 'mt-4'} min-h-12 min-w-[180px] touch-none select-none rounded-full px-5 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${
                    orbState === 'listening' ? 'bg-red-500 text-white' : 'bg-gold text-base-bg'
                  }`}
                  style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }}
                >
                  {({
                    preparing: 'جارٍ فتح الميكروفون…',
                    listening: 'إرسال ●',
                    transcribing: 'جارٍ الفهم…',
                    thinking: 'يفكر…',
                    speaking: 'إيقاف وتحدث',
                  })[orbState] || 'اضغط وتحدث'}
                </button>
                <p className={`mt-2 text-[11px] text-text-secondary ${conversationActive && orbState !== 'listening' ? 'hidden' : ''}`}>
                  {orbState === 'listening' ? 'اضغط مرة أخرى للإرسال، أو اترك الزر إن كنت تضغط باستمرار' : 'ضغطة للبدء وضغطة للإرسال'}
                </p>
              </div>

              <SendActionBanner />

              {/* شريط الإدخال */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  primeSpeech(); // inside the submit gesture, so iOS lets the reply speak
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
            </>
          ) : (
            <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 px-6 py-8 text-center">
              <p className="text-sm font-medium text-text-primary">
                {customerAccess.status === 'checking' ? 'جارٍ التحقق من أهلية الحساب...' : 'الوصول إلى Smart.z'}
              </p>
              {customerAccess.status !== 'checking' && (
                <p role="status" className="max-w-xs text-xs leading-5 text-text-secondary">
                  {customerAccess.message || 'يُرجى تسجيل الدخول أو التواصل مع إدارة الحساب لتفعيله.'}
                </p>
              )}
            </div>
          )}
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

            <section className="space-y-3 border-b border-base-border px-5 py-4" aria-label="حساب المستخدم">
              {!isSupabaseConfigured ? (
                <p role="status" className="text-xs leading-5 text-text-secondary">
                  إعداد Supabase Auth غير مكتمل. أضف عنوان المشروع والمفتاح العام في بيئة التشغيل.
                </p>
              ) : !authReady ? (
                <p className="text-xs text-text-secondary">جارٍ التحقق من الجلسة...</p>
              ) : authUser ? (
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-text-secondary">مسجل الدخول</p>
                    <p className="truncate text-sm text-text-primary" dir="ltr">{authUser.email}</p>
                  </div>
                  <button
                    type="button"
                    disabled={authBusy}
                    onClick={signOut}
                    className="min-h-9 rounded-lg border border-base-border px-3 text-xs text-text-secondary hover:bg-base-card hover:text-text-primary disabled:opacity-50"
                  >
                    تسجيل الخروج
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-text-secondary">غير مسجل الدخول</p>
                      <p className="text-sm text-text-primary">حساب Smart.z</p>
                    </div>
                    <button
                      type="button"
                      aria-expanded={authPanelOpen}
                      onClick={() => {
                        setAuthPanelOpen((open) => !open);
                        setAuthError('');
                        setAuthNotice('');
                      }}
                      className="min-h-9 rounded-lg border border-gold/40 px-3 text-xs text-gold hover:bg-gold/10"
                    >
                      {authPanelOpen ? 'إغلاق' : 'تسجيل الدخول'}
                    </button>
                  </div>

                  {authPanelOpen && (
                    <form onSubmit={submitAuth} className="space-y-3 rounded-lg border border-base-border bg-base-card p-3">
                      <label className="block space-y-1.5">
                        <span className="text-xs text-text-secondary">البريد الإلكتروني</span>
                        <input
                          type="email"
                          required
                          autoComplete="email"
                          value={authEmail}
                          onChange={(event) => setAuthEmail(event.target.value)}
                          className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-left text-sm text-text-primary"
                          dir="ltr"
                        />
                      </label>
                      <label className="block space-y-1.5">
                        <span className="text-xs text-text-secondary">كلمة المرور</span>
                        <input
                          type="password"
                          required
                          minLength={6}
                          autoComplete="current-password"
                          value={authPassword}
                          onChange={(event) => setAuthPassword(event.target.value)}
                          className="h-10 w-full rounded-md border border-base-border bg-base-panel px-3 text-left text-sm text-text-primary"
                          dir="ltr"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={authBusy}
                        className="min-h-10 w-full rounded-lg border border-gold/50 bg-gold/10 px-3 text-sm text-gold disabled:opacity-50"
                      >
                        {authBusy ? 'جارٍ تسجيل الدخول...' : 'دخول'}
                      </button>
                      <p className="text-xs leading-5 text-text-secondary">
                        حسابات العملاء ينشئها المدير؛ تواصل معه للحصول على بيانات الدخول.
                      </p>
                      {authError && <p role="alert" className="text-xs leading-5 text-red-300">{authError}</p>}
                      {authNotice && <p role="status" className="text-xs leading-5 text-text-secondary">{authNotice}</p>}
                    </form>
                  )}
                </div>
              )}
              {authError && authUser && <p role="alert" className="text-xs text-red-300">{authError}</p>}
              {authNotice && authUser && <p role="status" className="text-xs text-text-secondary">{authNotice}</p>}
            </section>

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
                        onChange={(event) => {
                          profileEditPendingRef.current = true;
                          setProfile((current) => ({ ...current, name: event.target.value }));
                          setProfileSaveNotice('');
                        }}
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
                            onClick={() => {
                              profileEditPendingRef.current = true;
                              setProfile((current) => ({ ...current, responseStyle: option.value }));
                              setProfileSaveNotice('');
                            }}
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
                            onClick={() => {
                              profileEditPendingRef.current = true;
                              setProfile((current) => ({ ...current, language: option.value }));
                              setProfileSaveNotice('');
                            }}
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
                    {profileSaveNotice && (
                      <p role="status" className="text-xs text-text-secondary">
                        {profileSaveNotice}
                      </p>
                    )}
                  </div>
                ) : activeSection === 'apps' ? (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">ربط التطبيقات</h2>
                      <p className="mt-1 text-xs text-text-secondary">اختر التطبيقات التي ترغب بإضافتها.</p>
                    </div>

                    <div className="space-y-2">
                      <WhatsAppClusterConnection
                        eligible={customerAccess.status === 'active' && Boolean(authSession?.access_token)}
                        getAccessToken={getAccessToken}
                        metaConnection={whatsappMetaConnection}
                        metaBusy={whatsappBusy || whatsappConnectionLoading}
                        metaError={whatsappError}
                        onStartMeta={startOfficialWhatsAppSignup}
                      />
                      <p className="text-xs leading-5 text-text-secondary">
                        نص الرسائل الواردة والرسائل الصوتية يُرسل إلى Groq (أو OpenRouter عند تعذره) لتوليد الرد، ولا تحفظ Smart.z سجل المحادثات.
                      </p>
                      <SendSettings />
                      <div className="space-y-2 rounded-lg border border-base-border bg-base-card p-3">
                        <h3 className="text-sm font-medium text-text-primary">فتح تطبيق على الهاتف</h3>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => launchExternalApp('whatsapp')}
                            className="min-h-10 rounded-lg border border-base-border px-3 text-sm text-text-primary hover:bg-base-panel"
                          >
                            فتح WhatsApp
                          </button>
                          <button
                            type="button"
                            onClick={() => launchExternalApp('x')}
                            className="min-h-10 rounded-lg border border-base-border px-3 text-sm text-text-primary hover:bg-base-panel"
                          >
                            فتح X
                          </button>
                        </div>
                        <div className="space-y-3 border-t border-base-border pt-3">
                          <h4 className="text-xs font-medium text-text-primary">تجهيز رسالة WhatsApp</h4>
                          <label className="block space-y-1.5">
                            <span className="text-xs text-text-secondary">رقم المستلم مع رمز الدولة</span>
                            <input
                              type="tel"
                              inputMode="numeric"
                              autoComplete="tel"
                              value={whatsappDraftPhone}
                              onChange={(event) => setWhatsappDraftPhone(event.target.value)}
                              placeholder="9665xxxxxxxx"
                              maxLength={20}
                              className="h-10 w-full rounded-lg border border-base-border bg-base-panel px-3 text-right text-sm text-text-primary"
                            />
                          </label>
                          <label className="block space-y-1.5">
                            <span className="text-xs text-text-secondary">نص الرسالة</span>
                            <textarea
                              value={whatsappDraftText}
                              onChange={(event) => setWhatsappDraftText(event.target.value)}
                              maxLength={4096}
                              rows={3}
                              className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-right text-sm text-text-primary"
                            />
                          </label>
                          <button
                            type="button"
                            disabled={!whatsappDraftPhone.trim() || !whatsappDraftText.trim()}
                            onClick={launchWhatsAppDraft}
                            className="min-h-10 w-full rounded-lg border border-gold/40 px-3 text-sm text-gold hover:bg-gold/10 disabled:opacity-50"
                          >
                            مراجعة الرسالة وفتح WhatsApp
                          </button>
                        </div>
                        <div className="space-y-3 border-t border-base-border pt-3">
                          <h4 className="text-xs font-medium text-text-primary">تجهيز تغريدة</h4>
                          <label className="block space-y-1.5">
                            <span className="text-xs text-text-secondary">نص التغريدة · {Array.from(tweetDraftText).length}/280</span>
                            <textarea
                              value={tweetDraftText}
                              onChange={(event) => setTweetDraftText(event.target.value)}
                              maxLength={280}
                              rows={3}
                              className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-right text-sm text-text-primary"
                            />
                          </label>
                          <button
                            type="button"
                            disabled={!tweetDraftText.trim()}
                            onClick={launchTweetDraft}
                            className="min-h-10 w-full rounded-lg border border-gold/40 px-3 text-sm text-gold hover:bg-gold/10 disabled:opacity-50"
                          >
                            مراجعة التغريدة وفتح X
                          </button>
                        </div>
                        <p className="text-xs leading-5 text-text-secondary">
                          لا يرسل Smart.z الرسائل أو ينشر التغريدات بنفسه. بعد مراجعتك وموافقتك يفتح مسودة في التطبيق؛ الإرسال أو النشر النهائي يبقى بيدك داخل التطبيق الخارجي.
                        </p>
                        {externalAppMessage && (
                          <p role="status" className="text-xs leading-5 text-amber-300">
                            {externalAppMessage}
                          </p>
                        )}
                      </div>
                      {whatsappError && (
                        <p role="alert" className="rounded-lg border border-gold/20 bg-gold/5 px-3 py-2 text-xs leading-5 text-text-secondary">
                          {whatsappError}
                        </p>
                      )}
                      {!authUser && authReady && (
                        <p className="text-xs text-text-secondary">سجّل الدخول لربط WhatsApp بحسابك.</p>
                      )}
                    </div>

                    <aside className="rounded-lg border border-gold/20 bg-gold/5 p-3 text-xs leading-5 text-text-secondary">
                      <p className="font-medium text-text-primary">قبل ربط أي تطبيق</p>
                      <p className="mt-1">قد يطلب التطبيق صلاحيات للوصول إلى بياناتك. راجع الصلاحيات والبيانات التي ستتم مشاركتها، واسأل عن استخدامها في الذاكرة قبل الموافقة.</p>
                      <p className="mt-2 text-gold/80">المتاح حاليًا هو ربط WhatsApp عبر Meta أو جلسة WhatsApp Web، وفتح WhatsApp أو X من حاوية Capacitor. نسخة PWA لا تستطيع تشغيل تطبيقات الهاتف؛ أما إرسال رسالة أو نشر تغريدة نيابة عنك فيحتاج API رسميًا وتأكيدًا منفصلًا على الإجراء.</p>
                    </aside>
                  </div>
                ) : activeSection === 'learning' ? (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">التعلم والتخصيص</h2>
                    </div>

                    <LearningPanel getAccessToken={getAccessToken} refreshKey={learningVersion} />

                    <div className="border-t border-base-border pt-4">
                      <h3 className="text-sm font-medium text-text-primary">ملاحظاتك للمساعد</h3>
                      <p className="mt-1 text-xs leading-5 text-text-secondary">
                        أشياء تريد أن يعرفها دائماً. تُرسل معه فقط إذا كان التعلّم الشخصي مفعّلاً.
                      </p>
                    </div>

                    <form onSubmit={saveMemory} className="space-y-3 rounded-lg border border-base-border bg-base-card p-3">
                      <label className="block space-y-2">
                        <span className="text-sm text-text-primary">إضافة ملاحظة</span>
                        <textarea
                          value={memoryDraft}
                          onChange={(event) => setMemoryDraft(event.target.value)}
                          maxLength={2000}
                          rows={3}
                          className="w-full rounded-lg border border-base-border bg-base-panel px-3 py-2 text-sm text-text-primary outline-none focus:border-gold/60"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={!memoriesLoaded || !memoryDraft.trim()}
                        className="min-h-10 rounded-lg border border-gold/40 px-4 text-sm text-gold hover:bg-gold/10 disabled:opacity-50"
                      >
                        حفظ على هذا الجهاز
                      </button>
                    </form>

                    {memoryError && <p role="alert" className="text-sm text-red-300">{memoryError}</p>}
                    {!memoriesLoaded ? (
                      <p className="text-sm text-text-secondary">جارٍ تحميل الذاكرة...</p>
                    ) : savedMemories.length === 0 ? (
                      <p className="rounded-lg border border-base-border bg-base-card px-4 py-5 text-sm text-text-secondary">
                        لا توجد ملاحظات بعد.
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
                ) : activeSection === 'notes' ? (
                  <LocalDataPanel collection="notes" />
                ) : activeSection === 'tasks' ? (
                    <LocalDataPanel
                      collection="tasks"
                      notificationStatus={taskNotificationStatus}
                      onNotificationStatusChange={setTaskNotificationStatus}
                    />
                ) : activeSection === 'audio' ? (
                  <div className="space-y-5">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">صوت المساعد</h2>
                      <p className="mt-1 text-xs leading-5 text-text-secondary">
                        الصوت السحابي هو المفضّل، وصوت الجهاز احتياطي يمكنك إيقافه.
                      </p>
                      <button
                        type="button"
                        onClick={() => setSetupOpen(true)}
                        className="mt-3 min-h-10 w-full rounded-lg border border-base-border px-3 text-sm text-text-primary hover:bg-base-card"
                      >
                        إعادة فحص الأذونات والصوت
                      </button>
                    </div>

                    <VoiceSettings />

                    <h3 className="text-sm font-medium text-text-primary">صوت الجهاز (الاحتياطي)</h3>

                    <>
                      {!audioSupported && (
                        <p role="alert" className="rounded-lg border border-base-border bg-base-card p-3 text-sm leading-6 text-text-secondary">
                          لا يتوفر محرك نطق قابل للتشغيل. يعرض التشخيص أدناه حالة كل واجهة والخطأ المُعاد.
                        </p>
                      )}
                        {audioVoiceInfo ? (
                          <p className="text-xs leading-5 text-text-secondary">
                            {audioVoiceInfo.native ? 'محرك Android' : 'محرك المتصفح'}: {audioVoiceInfo.name} ({audioVoiceInfo.language})
                            — {audioVoiceInfo.localService === true
                              ? 'صوت محلي'
                              : audioVoiceInfo.localService === false
                                ? 'الصوت يتطلب اتصالًا بالشبكة'
                                : 'لم يحدد الجهاز مصدر الصوت'}
                            {' '}— معلومة عن الصوت المتاح وليست إثباتًا لنجاح التشغيل
                          </p>
                        ) : audioVoiceError ? (
                          <p role="alert" className="text-xs leading-5 text-text-secondary">
                            {audioVoiceError}
                          </p>
                        ) : (
                          <p className="text-xs leading-5 text-text-secondary">
                            جارٍ فحص الأصوات العربية المتاحة...
                          </p>
                        )}
                        <button
                          type="button"
                          disabled={audioPreviewing}
                          onClick={async () => {
                            const audioFlow = audioFlowRef.current;
                            if (audioFlow?.isRecording || audioFlow?.isBusy) {
                              setAudioSettingsMessage('انتظر انتهاء رد المساعد قبل تجربة العينة.');
                              return;
                            }
                            primeSpeech(); // inside the tap, for iOS
                            setAudioPreviewing(true);
                            setAudioSettingsMessage('');
                            try {
                              const result = await testSpeechPlayback('مرحبًا، هذا اختبار للصوت العربي.');
                              const engineName = result.engine === 'android-native'
                                ? 'إضافة Android الأصلية'
                                : result.engine === 'native-plugin'
                                  ? 'إضافة النطق الأصلية'
                                  : 'محرك المتصفح';
                              setAudioSettingsMessage(result.success
                                ? `اكتمل اختبار النطق بنجاح عبر ${engineName} (اكتمل حدث النطق).`
                                : `فشل اختبار النطق عبر ${engineName}: ${result.error}`);
                              const diagnostics = await getSpeechDiagnostics();
                              setAudioDiagnostics(diagnostics);
                            } catch (error) {
                              console.error('[TTS] Voice preview failed:', error);
                              setAudioSettingsMessage(`فشل اختبار النطق: ${error?.message || String(error)}`);
                            } finally {
                              setAudioPreviewing(false);
                            }
                          }}
                          className="min-h-10 rounded-lg border border-gold/50 bg-gold/10 px-4 text-sm text-gold hover:bg-gold/15 disabled:opacity-50"
                        >
                          {audioPreviewing ? 'جارٍ تشغيل العينة...' : 'استمع إلى عينة'}
                        </button>

                        <p className="text-xs leading-5 text-text-secondary">
                          يعتمد توفر الصوت واتصاله بالإنترنت على محرك النطق المحدد في إعدادات الجهاز. لضمان النطق دون اتصال، ثبّت صوتًا عربيًا محليًا من إعدادات Android.
                        </p>
                        {audioSettingsMessage && (
                          <p
                            role={audioSettingsMessage.includes('فشل') ? 'alert' : 'status'}
                            className={`text-xs leading-5 ${
                              audioSettingsMessage.includes('فشل') ? 'text-red-300' : 'text-text-secondary'
                            }`}
                          >
                            {audioSettingsMessage}
                          </p>
                        )}
                        {canOpenSpeechEngineSettings() && (
                          <button
                            type="button"
                            disabled={audioSetupOpening}
                            onClick={async () => {
                              setAudioSetupOpening(true);
                              setAudioSettingsMessage('جارٍ فتح تثبيت بيانات الصوت في Android...');
                              try {
                                const result = await openSpeechEngineSettings();
                                const diagnostics = await getSpeechDiagnostics();
                                setAudioDiagnostics(diagnostics);
                                try {
                                  setAudioVoiceInfo(await getArabicVoiceInfo());
                                  setAudioVoiceError('');
                                } catch (error) {
                                  setAudioVoiceInfo(null);
                                  setAudioVoiceError(error?.message || 'لم يظهر صوت عربي بعد الرجوع من إعدادات المحرك.');
                                }
                                const availableArabicVoice = diagnostics.nativeEngine.arabicLanguages
                                  .some((language) => /^ar(?:-|$)/i.test(language) && !/^ar-JO(?:-|$)/i.test(language));
                                const action = result.action === 'settings'
                                  ? 'إعدادات تحويل النص إلى كلام'
                                  : 'شاشة تثبيت بيانات محرك النطق';
                                setAudioSettingsMessage(availableArabicVoice
                                  ? `عادت الشاشة من ${action} وتم العثور على لغة صوت عربي؛ جرّب العينة للتحقق من التشغيل.`
                                  : `عادت الشاشة من ${action}، لكن لم يظهر صوت عربي مثبت. اختر تنزيل/تثبيت صوت عربي داخل إعدادات المحرك، ثم أعد الاختبار.`);
                              } catch (error) {
                                console.error('[TTS] Could not open Android speech setup:', error);
                                setAudioSettingsMessage(`فشل فتح تثبيت بيانات الصوت: ${error?.message || String(error)}`);
                              } finally {
                                setAudioSetupOpening(false);
                              }
                            }}
                            className="min-h-9 rounded-lg border border-base-border px-3 text-xs text-text-secondary hover:bg-base-card hover:text-text-primary disabled:opacity-50"
                          >
                            {audioSetupOpening ? 'جارٍ فتح إعدادات الصوت...' : 'تنزيل أو تثبيت بيانات صوت Android'}
                          </button>
                        )}
                        <section
                          aria-label="تشخيص محركات النطق"
                          className="space-y-2 rounded-lg border border-base-border bg-base-card p-3"
                        >
                          <h3 className="text-xs font-semibold text-text-primary">تشخيص محركات النطق</h3>
                          {audioDiagnosticsLoading && !audioDiagnostics ? (
                            <p className="text-[11px] text-text-secondary">جارٍ جمع معلومات المحركات والأصوات...</p>
                          ) : audioDiagnostics?.error ? (
                            <p role="alert" className="text-[11px] text-red-300">{audioDiagnostics.error}</p>
                          ) : audioDiagnostics ? (
                            <>
                              <p className="text-[11px] text-text-secondary">
                                المنصة: {audioDiagnostics.platform} · Capacitor Native: {audioDiagnostics.capacitorNative ? 'نعم' : 'لا'} · إضافة TextToSpeech: {audioDiagnostics.textToSpeechPluginAvailable ? 'متاحة' : 'غير متاحة'} · SpeechSynthesis: {audioDiagnostics.browserSpeechSynthesisAvailable ? 'متاح' : 'غير متاح'}
                              </p>
                              {[
                                ['الإضافة الأصلية', audioDiagnostics.nativeEngine, 'getSupportedVoices'],
                                ['محرك المتصفح', audioDiagnostics.browserEngine, 'getVoices'],
                              ].map(([label, engine, queryName]) => (
                                <div key={label} className="border-t border-base-border/70 pt-2 text-[11px] leading-5 text-text-secondary">
                                  <p className="font-medium text-text-primary">{label}</p>
                                  <p>
                                    {queryName}: {engine.available
                                      ? engine.getSupportedVoicesSucceeded ? 'نجح' : 'فشل'
                                      : 'غير متاح'}
                                    {' '}· عدد الأصوات: {engine.voiceCount ?? 'غير متاح'}
                                    {' '}· اللغات العربية: {engine.arabicLanguages?.length
                                      ? engine.arabicLanguages.join('، ')
                                      : 'لا توجد أصوات عربية مُعادة'}
                                  </p>
                                  {engine.error && (
                                    <p role="alert" className="break-words text-red-300">
                                      الخطأ الفعلي: {engine.error}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </>
                          ) : (
                            <p className="text-[11px] text-text-secondary">لم تُجمع معلومات التشخيص بعد.</p>
                          )}
                        </section>
                    </>
                  </div>
                ) : activeSection === 'privacy' ? (
                  <div className="space-y-7">
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">الخصوصية والبيانات</h2>
                      <p className="mt-1 text-xs text-text-secondary">إعداد محفوظ على هذا الجهاز فقط.</p>
                    </div>
                    <div className="rounded-lg border border-base-border bg-base-card p-3 text-xs leading-5 text-text-secondary">
                      <p>تُخزّن الذاكرة والملاحظات والمهام وسجل المحادثة في IndexedDB على هذا الجهاز، ولا يزامنها Smart.z إلى خادم. Android مضبوط لتعطيل النسخ الاحتياطي للتطبيق؛ وقد تنطبق سياسات النسخ الاحتياطي العامة للجهاز على iPhone.</p>
                      <p className="mt-2">
                        {localStorageStatus.persistent
                          ? 'حماية التخزين المحلي: فعّالة؛ طلب التطبيق من النظام عدم إزالة البيانات تلقائيًا.'
                          : localStorageStatus.persistenceSupported
                            ? 'التخزين محلي، لكن النظام لم يضمن الاحتفاظ به عند انخفاض مساحة الجهاز. احتفظ بنسخة احتياطية إذا كانت البيانات مهمة.'
                            : 'التخزين محلي؛ هذا المتصفح لا يوفّر حماية إضافية من إزالة البيانات عند انخفاض مساحة الجهاز.'}
                      </p>
                      <p className="mt-2">تُرسل الرسائل النصية والتسجيلات الصوتية إلى Groq للمعالجة وتوليد الرد. إذا تعذّر Groq، قد يُرسل نص الطلب إلى OpenRouter كبديل لتوليد الردود النصية؛ لا تُرسل الملاحظات أو المهام أو الذكريات المحلية. يُنطق رد المساعد بصوت عربي محلي من الجهاز، ولا يُرسل النص إلى خدمة صوت خارجية.</p>
                      <p className="mt-2">عند تأكيد فتح مسودة WhatsApp أو X، يُشارك الرقم ونص المسودة مع الخدمة الخارجية لفتحها؛ لا يتم الإرسال أو النشر إلا بضغطك داخل التطبيق نفسه.</p>
                    </div>

                    <div className="space-y-3 border-t border-base-border pt-6">
                      <div>
                        <h3 className="text-sm font-medium text-text-primary">حذف البيانات</h3>
                        <p className="mt-1 text-xs leading-5 text-text-secondary">
                          يحذف الاسم والتفضيلات والذكريات والملاحظات والمهام وسجل المحادثة ومقاطع الصوت المخزنة محليًا على هذا الجهاز فقط.
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
                            هل تريد حذف كل البيانات المحلية، بما فيها الذكريات والملاحظات والمهام وسجل المحادثة ومقاطع الصوت؟ لا يمكن التراجع عن هذا الإجراء.
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
