// Fixed, bilingual replies. Refusals and "not found" never go through an LLM,
// so they cannot be talked into saying anything else.

import type { KnowledgeBase, Lang } from "../types";

const docList = (kb: KnowledgeBase, lang: Lang) =>
  kb.docs.map((d) => (lang === "ar" ? d.labelAr || d.labelEn : d.labelEn || d.subtitle || d.title)).join(lang === "ar" ? "، " : ", ");

export function greetingReply(kb: KnowledgeBase, lang: Lang): string {
  return lang === "ar"
    ? `مرحباً! أنا مساعد المملكة للوثائق. أجيب فقط عن الأسئلة التي تغطيها الوثائق المرفوعة: ${docList(kb, "ar")}. اسألني بالعربية أو الإنجليزية، وسأذكر المصدر ورقم الصفحة مع كل إجابة.`
    : `Hello! I'm the Almamlaka documents assistant. I only answer questions covered by the uploaded documents: ${docList(kb, "en")}. Ask in English or Arabic and I'll cite the document and page for every answer.`;
}

export function offTopicReply(kb: KnowledgeBase, lang: Lang): string {
  return lang === "ar"
    ? `لا تتوفر لدي معلومات عن هذا الموضوع، فهو خارج نطاق الوثائق المرفوعة. يمكنني الإجابة عن أسئلة تخص: ${docList(kb, "ar")}.`
    : `I don't have information about that — it's outside the uploaded documents. I can answer questions about: ${docList(kb, "en")}.`;
}

export function injectionReply(kb: KnowledgeBase, lang: Lang): string {
  return lang === "ar"
    ? `لا يمكنني تجاوز تعليماتي أو تغيير دوري. مهمتي الوحيدة هي الإجابة عن الأسئلة المتعلقة بالوثائق المرفوعة (${docList(kb, "ar")}). كيف أساعدك فيها؟`
    : `I can't ignore my instructions or change my role. I only answer questions about the uploaded documents (${docList(kb, "en")}). What would you like to know about them?`;
}

export function notFoundReply(lang: Lang): string {
  return lang === "ar"
    ? "لم أجد هذه المعلومة في الوثائق المرفوعة، لذلك لا أستطيع الإجابة عنها دون تخمين."
    : "I couldn't find this information in the uploaded documents, so I can't answer it without guessing.";
}

export function errorReply(lang: Lang, code: string, retryAfter = 0): string {
  if (code === "rate_limited") {
    return lang === "ar"
      ? `خدمة النموذج اللغوي وصلت إلى حد الطلبات المسموح به مؤقتاً. أعد إرسال سؤالك بعد ${Math.max(retryAfter, 5)} ثوانٍ.`
      : `The language-model service is temporarily rate-limited. Send your question again in ${Math.max(retryAfter, 5)} seconds.`;
  }
  if (code === "missing_key" || code === "bad_key") {
    return lang === "ar"
      ? "مفاتيح الخدمات (Groq / Jina) غير مضبوطة على الخادم. أضفها في إعدادات Netlify ثم أعد النشر."
      : "The Groq / Jina API keys are missing or invalid on the server. Add them in the Netlify environment settings and redeploy.";
  }
  return lang === "ar"
    ? "تعذّر إكمال الإجابة بسبب خطأ في خدمة خارجية. أعد المحاولة بعد قليل."
    : "The answer couldn't be completed because an external service failed. Please try again shortly.";
}
