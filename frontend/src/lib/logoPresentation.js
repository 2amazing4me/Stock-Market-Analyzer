const DEFAULT_LIGHT_LOGO_BACKGROUND = "#f4f6fa";
const DEFAULT_DARK_LOGO_BACKGROUND = "#111827";
const CONTRAST_LOGO_SHADOW = "drop-shadow(0 0 1px rgba(0, 0, 0, 0.42))";
const MAX_SAMPLE_SIZE = 72;

/** Returns a scaled canvas containing the logo image for pixel sampling. */
function logoSampleCanvas(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    return null;
  }

  const scale = Math.min(1, MAX_SAMPLE_SIZE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Returns perceived brightness for one RGB color. */
function luminance(red, green, blue) {
  return (0.299 * red) + (0.587 * green) + (0.114 * blue);
}

/** Returns a CSS rgb color from accumulated RGB channel totals. */
function rgbFromTotals(totals) {
  if (!totals.count) {
    return DEFAULT_LIGHT_LOGO_BACKGROUND;
  }
  return `rgb(${Math.round(totals.red / totals.count)}, ${Math.round(totals.green / totals.count)}, ${Math.round(totals.blue / totals.count)})`;
}

/** Returns whether a sampled pixel is near one of the image corners. */
function isCornerPixel(x, y, width, height) {
  const xEdge = Math.max(2, Math.ceil(width * 0.16));
  const yEdge = Math.max(2, Math.ceil(height * 0.16));
  const leftOrRight = x < xEdge || x >= width - xEdge;
  const topOrBottom = y < yEdge || y >= height - yEdge;
  return leftOrRight && topOrBottom;
}

/** Chooses a circular background color that keeps a loaded logo fully visible. */
export function logoPresentationStyle(image) {
  try {
    const canvas = logoSampleCanvas(image);
    if (!canvas) {
      return {};
    }

    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const visible = { red: 0, green: 0, blue: 0, count: 0 };
    const corners = { red: 0, green: 0, blue: 0, count: 0 };
    let transparentCount = 0;

    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        const index = ((y * canvas.width) + x) * 4;
        const alpha = data[index + 3];
        if (alpha < 24) {
          transparentCount += 1;
          continue;
        }

        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        visible.red += red;
        visible.green += green;
        visible.blue += blue;
        visible.count += 1;

        if (isCornerPixel(x, y, canvas.width, canvas.height)) {
          corners.red += red;
          corners.green += green;
          corners.blue += blue;
          corners.count += 1;
        }
      }
    }

    if (!visible.count) {
      return { backgroundColor: DEFAULT_LIGHT_LOGO_BACKGROUND };
    }

    const transparentRatio = transparentCount / (canvas.width * canvas.height);
    const averageBrightness = luminance(visible.red / visible.count, visible.green / visible.count, visible.blue / visible.count);
    if (transparentRatio > 0.08) {
      return {
        backgroundColor: averageBrightness > 215 ? DEFAULT_DARK_LOGO_BACKGROUND : DEFAULT_LIGHT_LOGO_BACKGROUND,
        "--logo-image-filter": averageBrightness > 215 ? "none" : CONTRAST_LOGO_SHADOW,
      };
    }

    return {
      backgroundColor: rgbFromTotals(corners),
      "--logo-image-filter": "none",
    };
  } catch {
    return {};
  }
}
