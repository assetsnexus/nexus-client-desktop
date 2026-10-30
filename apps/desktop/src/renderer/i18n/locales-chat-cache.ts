/**
 * Durable chat-cache UI translations.
 *
 * Kept in a separate module (rather than inlined into `locales.ts`) so the chat
 * cache can be added without restructuring the shared dictionary file. The keys
 * are part of the English source dictionary; `locales.ts` merges these per-locale
 * blocks into `DICTIONARIES` so the i18n registry invariants hold (every locale
 * covers every English key).
 */

import type { Locale } from './locales.js';

export const CHAT_CACHE_LOCALE_MESSAGES: Record<Locale, Record<string, string>> = {
  en: {
    'settings.chatCache': 'Chat cache',
    'settings.chatCache.help':
      'Conversation lists and short message previews are cached locally so the chat opens instantly after a reload; message bodies are always refetched. The cache is wiped whenever you sign out.',
    'settings.chatCache.maxBytes': 'Keep cache under',
    'settings.chatCache.usage': 'Using {used} across {entries} entries',
    'settings.chatCache.evicted': '{count} evicted',
    'settings.chatCache.clear': 'Clear chat cache',
  },
  de: {
    'settings.chatCache': 'Chat-Zwischenspeicher',
    'settings.chatCache.help':
      'Konversationslisten und kurze Nachrichtenvorschauen werden lokal zwischengespeichert, damit der Chat nach einem Neuladen sofort öffnet; Nachrichteninhalte werden immer neu geladen. Der Zwischenspeicher wird bei jeder Abmeldung geleert.',
    'settings.chatCache.maxBytes': 'Zwischenspeicher begrenzen auf',
    'settings.chatCache.usage': '{used} in {entries} Einträgen',
    'settings.chatCache.evicted': '{count} verdrängt',
    'settings.chatCache.clear': 'Chat-Zwischenspeicher leeren',
  },
  es: {
    'settings.chatCache': 'Caché de chat',
    'settings.chatCache.help':
      'Las listas de conversaciones y las vistas previas breves se guardan localmente para que el chat se abra al instante tras recargar; el cuerpo de los mensajes siempre se vuelve a cargar. La caché se borra al cerrar sesión.',
    'settings.chatCache.maxBytes': 'Mantener la caché por debajo de',
    'settings.chatCache.usage': 'Usando {used} en {entries} entradas',
    'settings.chatCache.evicted': '{count} eliminadas',
    'settings.chatCache.clear': 'Borrar caché de chat',
  },
  fr: {
    'settings.chatCache': 'Cache de discussion',
    'settings.chatCache.help':
      "Les listes de conversations et les aperçus courts sont mis en cache localement pour que la discussion s'ouvre instantanément après un rechargement ; le corps des messages est toujours rechargé. Le cache est vidé à chaque déconnexion.",
    'settings.chatCache.maxBytes': 'Limiter le cache à',
    'settings.chatCache.usage': '{used} sur {entries} entrées',
    'settings.chatCache.evicted': '{count} évincées',
    'settings.chatCache.clear': 'Vider le cache de discussion',
  },
  ru: {
    'settings.chatCache': 'Кэш чата',
    'settings.chatCache.help':
      'Списки бесед и краткие превью сообщений кэшируются локально, чтобы чат открывался мгновенно после перезагрузки; тела сообщений всегда загружаются заново. Кэш очищается при каждом выходе из системы.',
    'settings.chatCache.maxBytes': 'Ограничить кэш до',
    'settings.chatCache.usage': 'Использовано {used} в {entries} записях',
    'settings.chatCache.evicted': 'Вытеснено: {count}',
    'settings.chatCache.clear': 'Очистить кэш чата',
  },
  uk: {
    'settings.chatCache': 'Кеш чату',
    'settings.chatCache.help':
      'Списки розмов і короткі прев’ю повідомлень кешуються локально, щоб чат відкривався миттєво після перезавантаження; тіла повідомлень завжди завантажуються заново. Кеш очищується під час кожного виходу з системи.',
    'settings.chatCache.maxBytes': 'Обмежити кеш до',
    'settings.chatCache.usage': 'Використано {used} у {entries} записах',
    'settings.chatCache.evicted': 'Вилучено: {count}',
    'settings.chatCache.clear': 'Очистити кеш чату',
  },
  et: {
    'settings.chatCache': 'Vestlusvahemälu',
    'settings.chatCache.help':
      'Vestlusloendid ja lühikesed sõnumieelvaated salvestatakse kohapeal, et vestlus avaneks kohe pärast uuesti laadimist; sõnumite sisu laaditakse alati uuesti. Vahemälu tühjendatakse iga väljalogimise järel.',
    'settings.chatCache.maxBytes': 'Piira vahemälu suuruseks',
    'settings.chatCache.usage': 'Kasutusel {used}, {entries} kirjet',
    'settings.chatCache.evicted': '{count} eemaldatud',
    'settings.chatCache.clear': 'Tühjenda vestlusvahemälu',
  },
  it: {
    'settings.chatCache': 'Cache della chat',
    'settings.chatCache.help':
      'Gli elenchi delle conversazioni e le anteprime brevi vengono memorizzati localmente, così la chat si apre subito dopo un ricaricamento; il corpo dei messaggi viene sempre ricaricato. La cache viene svuotata a ogni disconnessione.',
    'settings.chatCache.maxBytes': 'Mantieni la cache sotto',
    'settings.chatCache.usage': 'In uso {used} su {entries} voci',
    'settings.chatCache.evicted': '{count} rimosse',
    'settings.chatCache.clear': 'Svuota cache della chat',
  },
  pt: {
    'settings.chatCache': 'Cache do chat',
    'settings.chatCache.help':
      'As listas de conversas e as pré-visualizações curtas são guardadas localmente para que o chat abra instantaneamente após recarregar; o corpo das mensagens é sempre recarregado. A cache é limpa sempre que termina a sessão.',
    'settings.chatCache.maxBytes': 'Manter a cache abaixo de',
    'settings.chatCache.usage': 'A usar {used} em {entries} entradas',
    'settings.chatCache.evicted': '{count} removidas',
    'settings.chatCache.clear': 'Limpar cache do chat',
  },
  nl: {
    'settings.chatCache': 'Chatcache',
    'settings.chatCache.help':
      'Gesprekslijsten en korte berichtvoorbeelden worden lokaal bewaard zodat de chat direct opent na een herlaadbeurt; berichtinhoud wordt altijd opnieuw opgehaald. De cache wordt gewist bij elke afmelding.',
    'settings.chatCache.maxBytes': 'Cache beperken tot',
    'settings.chatCache.usage': '{used} in gebruik over {entries} items',
    'settings.chatCache.evicted': '{count} verwijderd',
    'settings.chatCache.clear': 'Chatcache wissen',
  },
  pl: {
    'settings.chatCache': 'Pamięć podręczna czatu',
    'settings.chatCache.help':
      'Listy rozmów i krótkie podglądy wiadomości są zapisywane lokalnie, aby czat otwierał się natychmiast po przeładowaniu; treść wiadomości jest zawsze pobierana ponownie. Pamięć jest czyszczona przy każdym wylogowaniu.',
    'settings.chatCache.maxBytes': 'Ogranicz pamięć do',
    'settings.chatCache.usage': 'Użyto {used} w {entries} wpisach',
    'settings.chatCache.evicted': 'Usunięto: {count}',
    'settings.chatCache.clear': 'Wyczyść pamięć czatu',
  },
  tr: {
    'settings.chatCache': 'Sohbet önbelleği',
    'settings.chatCache.help':
      'Konuşma listeleri ve kısa mesaj önizlemeleri, sohbetin yeniden yüklemeden sonra anında açılması için yerel olarak önbelleğe alınır; mesaj içerikleri her zaman yeniden alınır. Önbellek her oturum kapatmada temizlenir.',
    'settings.chatCache.maxBytes': 'Önbelleği şunun altında tut',
    'settings.chatCache.usage': '{entries} kayıtta {used} kullanılıyor',
    'settings.chatCache.evicted': '{count} kaldırıldı',
    'settings.chatCache.clear': 'Sohbet önbelleğini temizle',
  },
  ar: {
    'settings.chatCache': 'ذاكرة الدردشة المؤقتة',
    'settings.chatCache.help':
      'تُخزَّن قوائم المحادثات ومعاينات الرسائل القصيرة محليًا ليُفتح الدردشة فورًا بعد إعادة التحميل؛ ويُعاد دائمًا جلب متن الرسائل. تُمسح الذاكرة المؤقتة عند كل تسجيل خروج.',
    'settings.chatCache.maxBytes': 'احتفظ بالذاكرة تحت',
    'settings.chatCache.usage': 'يُستخدم {used} عبر {entries} عنصرًا',
    'settings.chatCache.evicted': 'تم حذف {count}',
    'settings.chatCache.clear': 'مسح ذاكرة الدردشة المؤقتة',
  },
  hi: {
    'settings.chatCache': 'चैट कैश',
    'settings.chatCache.help':
      'बातचीत सूचियाँ और छोटे संदेश पूर्वावलोकन स्थानीय रूप से कैश किए जाते हैं ताकि रीलोड के बाद चैट तुरंत खुले; संदेश का मुख्य भाग हमेशा फिर से लाया जाता है। साइन आउट पर कैश मिटा दिया जाता है।',
    'settings.chatCache.maxBytes': 'कैश इससे कम रखें',
    'settings.chatCache.usage': '{entries} प्रविष्टियों में {used} उपयोग',
    'settings.chatCache.evicted': '{count} हटाए गए',
    'settings.chatCache.clear': 'चैट कैश साफ़ करें',
  },
  zh: {
    'settings.chatCache': '聊天缓存',
    'settings.chatCache.help':
      '会话列表和短消息预览会缓存在本地，使聊天在重新加载后立即打开；消息正文始终会重新获取。每次退出登录时都会清空缓存。',
    'settings.chatCache.maxBytes': '将缓存限制在',
    'settings.chatCache.usage': '在 {entries} 个条目中使用 {used}',
    'settings.chatCache.evicted': '已移除 {count} 个',
    'settings.chatCache.clear': '清除聊天缓存',
  },
  ja: {
    'settings.chatCache': 'チャットキャッシュ',
    'settings.chatCache.help':
      '会話リストと短いメッセージプレビューをローカルにキャッシュし、再読み込み後すぐにチャットを開けるようにします。メッセージ本文は常に再取得します。キャッシュはサインアウトのたびに消去されます。',
    'settings.chatCache.maxBytes': 'キャッシュの上限',
    'settings.chatCache.usage': '{entries} 件で {used} 使用中',
    'settings.chatCache.evicted': '{count} 件を削除',
    'settings.chatCache.clear': 'チャットキャッシュを消去',
  },
  ko: {
    'settings.chatCache': '채팅 캐시',
    'settings.chatCache.help':
      '대화 목록과 짧은 메시지 미리보기를 로컬에 캐시하여 새로 고친 뒤 채팅이 즉시 열리도록 합니다. 메시지 본문은 항상 다시 가져옵니다. 캐시는 로그아웃할 때마다 지워집니다.',
    'settings.chatCache.maxBytes': '캐시 최대 크기',
    'settings.chatCache.usage': '{entries}개 항목에 {used} 사용 중',
    'settings.chatCache.evicted': '{count}개 제거됨',
    'settings.chatCache.clear': '채팅 캐시 지우기',
  },
};
