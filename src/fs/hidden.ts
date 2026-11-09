/**
 * Hidden-path policy: a path with any component starting with '.' (a dotfile, or anything inside a dot-named folder,
 * including an allowed folder that is itself hidden or sits inside one) is never read or listed, and hidden allowed
 * folders aren't named in descriptions, hints or list_allowed_folders. Name-based on every platform (Windows
 * hidden/system attributes are not consulted). Writes are not affected.
 */
export function isHiddenPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  return p.split(platform === "win32" ? /[\\/]/ : "/").some((seg) => seg.length > 0 && seg.startsWith("."));
}
