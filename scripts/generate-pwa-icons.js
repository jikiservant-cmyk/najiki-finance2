const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(process.cwd(), 'public', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

// Crisp SVG with rounded-rect background matching dark theme and Najiki branding
const createSvg = (size, isMaskable = false) => {
  const padding = isMaskable ? size * 0.2 : size * 0.12;
  const contentSize = size - padding * 2;
  const bgRadius = isMaskable ? 0 : Math.round(size * 0.22);

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${size}" height="${size}" rx="${bgRadius}" fill="#09090b" />
    <g transform="translate(${padding}, ${padding}) scale(${contentSize / 30})">
      <path fill="#18181b" stroke="#3f3f46" stroke-width="0.6" d="M24.51,28.51H5.49c-2.21,0-4-1.79-4-4V5.49c0-2.21,1.79-4,4-4h19.03c2.21,0,4,1.79,4,4v19.03 C28.51,26.72,26.72,28.51,24.51,28.51z"/>
      <path fill="#ffffff" d="M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z"/>
      <polygon fill="#3b82f6" points="24.3,7.1 13.14,22.91 5.7,22.91 16.86,7.1"/>
      <path fill="#ffffff" d="M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z"/>
    </g>
  </svg>`;
};

async function generate() {
  const sizes = [
    { name: 'icon-192x192.png', size: 192, maskable: false },
    { name: 'icon-512x512.png', size: 512, maskable: false },
    { name: 'icon-maskable-192x192.png', size: 192, maskable: true },
    { name: 'icon-maskable-512x512.png', size: 512, maskable: true },
    { name: 'apple-touch-icon.png', size: 180, maskable: false },
    { name: 'favicon-32x32.png', size: 32, maskable: false },
    { name: 'favicon-16x16.png', size: 16, maskable: false },
  ];

  for (const { name, size, maskable } of sizes) {
    const svgBuffer = Buffer.from(createSvg(size, maskable));
    await sharp(svgBuffer)
      .png()
      .toFile(path.join(iconsDir, name));
    console.log('Created', name);
  }

  // Also write SVG icon
  fs.writeFileSync(path.join(iconsDir, 'icon.svg'), createSvg(512, false));
  console.log('Icons generated successfully!');
}

generate().catch(console.error);
