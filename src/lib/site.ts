// 站点身份常量与共享 schema
// 集中维护品牌实体信息，供各页面 schema 复用，保证 sameAs / author / publisher 一致性。

export const SITE_URL = "https://www.image-2-stl.com";
export const SITE_NAME = "Image to STL Converter";
export const SITE_EMAIL = "hello@image-2-stl.com";
export const ORG_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;

// 站点内容的发布日期与最后更新时间（全站统一维护）
export const SITE_PUBLISHED = "2025-06-01";
export const SITE_MODIFIED = "2026-09-18";

// 品牌官方档案地址（sameAs）。
// 说明：仅列出真实存在、可公开验证的档案页，不虚构社交账号。
export const SAME_AS: string[] = [
  "https://github.com/jiusongvip/image-to-stl",
];

// 站点主题实体（about / mentions）。
// 这些是「本站在讲什么」的外部权威实体，指向 Wikidata / Wikipedia，
// 用于帮助 AI 引擎将内容归入正确的知识图谱节点。
// 注意：与 SAME_AS 语义不同 —— SAME_AS 声明「我是谁」，
// 下列实体声明「我在讲什么」，因此放在 about / mentions 而非 sameAs。
export const TOPIC_ENTITIES = [
  {
    "@type": "DefinedTerm",
    name: "STL (STereoLithography) file format",
    sameAs: [
      "https://www.wikidata.org/wiki/Q1238229",
      "https://en.wikipedia.org/wiki/STL_(file_format)",
    ],
  },
  {
    "@type": "DefinedTerm",
    name: "3D printing",
    sameAs: [
      "https://www.wikidata.org/wiki/Q229367",
      "https://en.wikipedia.org/wiki/3D_printing",
    ],
  },
  {
    "@type": "DefinedTerm",
    name: "Lithophane",
    sameAs: [
      "https://www.wikidata.org/wiki/Q623020",
      "https://en.wikipedia.org/wiki/Lithophane",
    ],
  },
];

// 品牌 / 出版商实体，供 WebSite、SoftwareApplication、BlogPosting 等引用
export const ORGANIZATION = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: SITE_NAME,
  url: SITE_URL,
  email: SITE_EMAIL,
  description:
    "Free browser-based tools that convert images into 3D-printable STL models. All processing runs locally — no uploads, no registration.",
  foundingDate: "2025",
  ...(SAME_AS.length > 0 ? { sameAs: SAME_AS } : {}),
};

// 内容团队署名（作者身份），供页面级 author 字段引用。
// 与 ORGANIZATION 指向同一实体的 @id，避免出现「两个品牌」的实体歧义。
export const AUTHOR = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: `${SITE_NAME} Team`,
  url: `${SITE_URL}/about/`,
  ...(SAME_AS.length > 0 ? { sameAs: SAME_AS } : {}),
};

// 便捷函数：为页面 schema 附加 publisher / author / 日期字段
//
// 同时把品牌 sameAs 提升到**页面级主节点**上。
// 背景：sameAs 只挂在嵌套的 Organization 上时，审计工具（以及部分 AI 引擎）
// 检查「主实体是否声明了外部身份链接」会判定为缺失 —— 它们只看顶层节点。
// 因此这里在主节点上再声明一次，让 WebSite / SoftwareApplication /
// FAQPage / AboutPage 等任何主实体都直接携带 sameAs。
export function withProvenance<T extends Record<string, unknown>>(
  schema: T,
  options: {
    published?: string;
    modified?: string;
    withAuthor?: boolean;
  } = {}
): T & Record<string, unknown> {
  const { published = SITE_PUBLISHED, modified = SITE_MODIFIED, withAuthor = true } = options;
  return {
    ...schema,
    ...(SAME_AS.length > 0 ? { sameAs: SAME_AS } : {}),
    publisher: ORGANIZATION,
    ...(withAuthor ? { author: AUTHOR } : {}),
    datePublished: published,
    dateModified: modified,
  };
}
