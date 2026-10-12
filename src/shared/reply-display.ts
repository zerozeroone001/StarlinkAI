// Older image replies can contain narration concatenated before the final answer.
// Trim only a recognized leading preamble when an actual image is present.
export function imageReplyBody(text: string, hasImages: boolean): string {
  if (!hasImages) return text
  return text.replace(
    /^(?:\s*(?:(?:我会|我将|我先|先)(?:读取|阅读|查看|使用|调用)[^\n。！？]*?(?:技能|工具)[^\n。！？]*[。！]|(?:正在|开始)(?:为你|为您)?生成[^\n。！？]*[。！]|(?:写真|图片|图像|照片)已生成[，,、\s]*(?:可直接查看|请查看|如下|见下图)[：:。！]))+/u,
    ''
  ).trimStart()
}
