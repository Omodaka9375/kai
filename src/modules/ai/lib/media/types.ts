/** Result from an image generation provider. */
export type ImageResult = {
  /** Remote URL (temporary — download promptly). */
  url?: string;
  /** Base64-encoded image data. */
  base64?: string;
  mimeType: string;
  width: number;
  height: number;
  provider: string;
  /** Local file path if saved to disk. */
  savedPath?: string;
};

/** Result from a video generation provider. */
export type VideoResult = {
  url: string;
  mimeType: string;
  durationSeconds: number;
  provider: string;
  thumbnailBase64?: string;
  savedPath?: string;
};

/** Normalized image generation interface. */
export type ImageGenerateOpts = {
  prompt: string;
  size?: string;
  quality?: string;
  /** Base64 of a reference image for editing. */
  referenceImage?: string;
};

/** Normalized video generation interface. */
export type VideoGenerateOpts = {
  prompt: string;
  duration?: number;
  aspectRatio?: string;
  /** Base64 of a reference image to animate. */
  referenceImage?: string;
};
