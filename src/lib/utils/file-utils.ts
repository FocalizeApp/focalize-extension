export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export const IMAGE_TYPES = [
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/tiff',
    'image/webp',
    'image/x-ms-bmp',
];

export const SUPPORTED_MIME_TYPES = [
    'audio/wav',
    'audio/mpeg',
    'audio/ogg',
    'video/ogg',
    'video/ogv',
    'video/mp4',
    'video/webm',
    'video/x-m4v',
    ...IMAGE_TYPES,
];

export const supportedMimeTypesJoined = () => {
    return SUPPORTED_MIME_TYPES.join(',');
};

export const imageMimeTypesJoined = () => {
    return IMAGE_TYPES.join(',');
};
