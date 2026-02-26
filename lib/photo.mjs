/**
 * IMAGIN.studio vehicle photo URL builder.
 * No API calls needed - constructs CDN URLs directly.
 * Docs: https://www.imagin.studio/
 */

const CDN_BASE = 'https://cdn.imagin.studio/getImage';

/**
 * Standard angle mappings for IMAGIN.studio.
 * Angles range from 01-29 representing different viewpoints.
 */
const ANGLES = {
  front: '01',
  angle: '05',
  side: '09',
  rear: '17',
};

/**
 * Build a photo URL for a specific vehicle and angle.
 *
 * @param {string} make - Vehicle make (e.g., "Toyota")
 * @param {string} model - Vehicle model (e.g., "Camry")
 * @param {number|string} year - Model year
 * @param {object} [options] - Optional parameters
 * @param {string} [options.angle] - Angle code (01-29), default "01"
 * @param {number} [options.width] - Image width in pixels, default 800
 * @param {string} [options.paintId] - Paint/color identifier
 * @returns {string} CDN URL for the vehicle photo
 */
export function getPhotoUrl(make, model, year, options = {}) {
  const params = new URLSearchParams({
    customer: 'demo',
    make: String(make),
    modelFamily: String(model),
    modelYear: String(year),
    angle: options.angle || ANGLES.front,
    width: String(options.width || 800),
  });

  if (options.paintId) {
    params.set('paintId', options.paintId);
  }

  return `${CDN_BASE}?${params}`;
}

/**
 * Get photo URLs for multiple standard angles.
 *
 * @param {string} make - Vehicle make (e.g., "Toyota")
 * @param {string} model - Vehicle model (e.g., "Camry")
 * @param {number|string} year - Model year
 * @param {object} [options] - Optional parameters
 * @param {number} [options.width] - Image width in pixels, default 800
 * @param {string} [options.paintId] - Paint/color identifier
 * @returns {object} { front, side, rear, angle } - URLs for each view
 */
export function getPhotoUrls(make, model, year, options = {}) {
  return {
    front: getPhotoUrl(make, model, year, { ...options, angle: ANGLES.front }),
    side: getPhotoUrl(make, model, year, { ...options, angle: ANGLES.side }),
    rear: getPhotoUrl(make, model, year, { ...options, angle: ANGLES.rear }),
    angle: getPhotoUrl(make, model, year, { ...options, angle: ANGLES.angle }),
  };
}
