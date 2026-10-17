export const hasTransparentPixels = async (blob: Blob) => {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not get canvas context.');
    }
    context.drawImage(img, 0, 0);
    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData?.data;
    if (!data) {
      throw new Error('Could not get image data.');
    }
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 255) {
        return true;
      }
    }
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
};
