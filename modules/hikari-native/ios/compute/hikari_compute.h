#ifndef HIKARI_COMPUTE_H
#define HIKARI_COMPUTE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * CPU image math shared by the iOS and Android modules. Plain C so Swift can import it.
 * Every buffer is tightly packed; images are top-left origin, w * h pixels.
 */

/** Snaps a soft mask to the photo's edges. guide: RGBA8. mask: RGBA8 (red) or 1 byte per pixel. out: w * h bytes. */
void hk_refine_mask(const uint8_t *guide, const uint8_t *mask, size_t maskLen, int32_t w, int32_t h, int32_t radius, double eps, double lo, double hi, uint8_t *out);

/** Object mask from a brush selection. guide, coverage: RGBA8. selected: nullable, RGBA8 or 1 byte per pixel. out: w * h bytes. */
void hk_object_mask(const uint8_t *guide, const uint8_t *coverage, size_t coverageLen, const uint8_t *selected, size_t selectedLen, int32_t w, int32_t h, uint8_t *out);

/** Picks the segmented objects under a brush selection. out: n bytes (0 or 255). Returns how many were picked. */
int32_t hk_select_instances(const uint8_t *labels, int32_t labelStride, int32_t count, const uint8_t *coverage, int32_t coverageStride, int32_t n, double minCover, double minShare, uint8_t *out);

/**
 * Content-aware removal of one area.
 * pixels: 3 floats per pixel, filled in place. area: 0/1 per pixel. alpha: blend weight, raised in place.
 */
void hk_remove_spot(float *pixels, const uint8_t *area, float *alpha, int32_t w, int32_t h, int32_t grow, int32_t feather, int32_t searchMaxDim, uint32_t seed);

/** 256-bin histogram of RGBA8 pixels. bins: 1024 values (r, g, b, luma). */
void hk_histogram(const uint8_t *px, size_t len, int32_t step, uint32_t *bins, uint32_t *total, double *clipLow, double *clipHigh);

/** Sky probability mask from RGBA8 pixels. out: w * h bytes. */
void hk_sky_mask(const uint8_t *px, int32_t w, int32_t h, uint8_t *out);

/**
 * Auto tone and white balance from RGBA8 pixels.
 * light: exposure, contrast, highlights, shadows, whites, blacks. wb: temperature, tint.
 */
void hk_auto_adjust(const uint8_t *px, size_t len, double *light, double *wb);

/** Gaussian blur of an 8-bit plane, in place. */
void hk_blur_planar8(uint8_t *plane, int32_t w, int32_t h, double sigma);

/**
 * Adds one brush stroke's coverage to a mask at (x, y).
 * erase darkens toward black; otherwise lightens toward white, by flow.
 */
void hk_compose_stroke(uint8_t *mask, int32_t maskW, int32_t maskH, const uint8_t *coverage, int32_t x, int32_t y, int32_t w, int32_t h, double flow, int32_t erase);

/** Expands one byte per pixel to opaque gray RGBA8. out: n * 4 bytes. */
void hk_gray_to_rgba(const uint8_t *gray, int32_t n, uint8_t *out);

/**
 * Region of a mask image (RGBA8, red channel) stretched over a W x H frame, as 0/1 above `threshold`.
 * out: w * h bytes.
 */
void hk_region_area(const uint8_t *rgba, int32_t maskW, int32_t maskH, int32_t W, int32_t H, int32_t x, int32_t y, int32_t w, int32_t h, int32_t threshold, uint8_t *out);

/** Blends white into RGB by an alpha plane. dst: RGBA8, or RGBA16 when bits is 16. */
void hk_apply_watermark(uint8_t *dst, int32_t w, int32_t h, const uint8_t *alpha, int32_t alphaRowBytes, int32_t bits);

#ifdef __cplusplus
}
#endif

#endif
