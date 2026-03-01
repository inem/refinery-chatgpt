from PIL import Image, ImageDraw

sizes = [16, 48, 128]

for size in sizes:
    img = Image.new('RGBA', (size, size), (59, 130, 246, 255))  # Blue
    draw = ImageDraw.Draw(img)
    
    # Draw a simple bookmark shape
    margin = size // 6
    draw.rectangle([margin, margin, size - margin, size - margin], fill=(255, 255, 255, 255))
    draw.rectangle([margin + size//8, margin + size//8, size - margin - size//8, size - margin - size//8], fill=(59, 130, 246, 255))
    
    img.save(f'icon{size}.png')
    print(f'Created icon{size}.png')
