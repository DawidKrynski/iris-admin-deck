// WCAG relative luminance and contrast for opaque six-digit sRGB colours.
export function contrast(foreground, background) {
  const luminance = (hex) => {
    if (!/^#[\da-f]{6}$/i.test(hex)) throw new TypeError('Expected #rrggbb');
    const rgb = hex.slice(1).match(/../g).map((part) => {
      const c = parseInt(part, 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(foreground); const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
