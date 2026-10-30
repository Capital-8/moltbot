function controlUiAssetPathFromUrl(value: string): string | null {
  const normalized = value.split(/[?#]/u, 1)[0]?.replace(/\\/gu, "/") ?? "";
  const markerIndex = normalized.lastIndexOf("assets/");
  if (markerIndex === -1) {
    return null;
  }
  const assetPath = normalized.slice(markerIndex);
  if (assetPath.includes("../") || !/\.(?:css|js)$/u.test(assetPath)) {
    return null;
  }
  return assetPath;
}

export function extractControlUiStartupAssetPaths(html: string): string[] {
  const assets = new Set<string>();
  let templateDepth = 0;
  // Template contents stay inert until their owner inserts them into the document.
  for (const tag of html.matchAll(/<(\/?)template\b[^>]*>|<(?:link|script)\b[^>]*>/giu)) {
    if (tag[1] !== undefined) {
      templateDepth = Math.max(0, templateDepth + (tag[1] ? -1 : 1));
      continue;
    }
    if (templateDepth > 0) {
      continue;
    }
    const attribute = tag[0].match(/\s(?:href|src)\s*=\s*["']([^"']+)["']/iu);
    const assetPath = attribute?.[1] ? controlUiAssetPathFromUrl(attribute[1]) : null;
    if (assetPath) {
      assets.add(assetPath);
    }
  }
  return [...assets].toSorted((left, right) => left.localeCompare(right));
}
