#!/usr/bin/env python3.11
"""
图片压缩脚本：从 stdin 读取 base64 图片，压缩后输出 base64。
输入 JSON: { "images": [{ "data": "base64...", "media_type": "image/jpeg" }, ...], "max_total_bytes": 8000000 }
输出 JSON: { "images": [{ "data": "base64...", "media_type": "image/jpeg" }, ...] }
策略：先尝试降质量，再尝试缩小尺寸，逐步压缩直到总大小合规。
"""
import sys, json, base64, io
from PIL import Image

def compress_image(img_bytes, media_type, target_bytes):
    """压缩单张图片到目标大小"""
    img = Image.open(io.BytesIO(img_bytes))

    # RGBA 转 RGB（JPEG 不支持 alpha）
    if img.mode in ('RGBA', 'P'):
        img = img.convert('RGB')
        media_type = 'image/jpeg'

    # 逐步压缩：先降质量，再缩尺寸
    for scale in [1.0, 0.75, 0.5, 0.35, 0.25]:
        w, h = img.size
        new_w, new_h = int(w * scale), int(h * scale)
        if new_w < 100 or new_h < 100:
            continue
        resized = img.resize((new_w, new_h), Image.LANCZOS) if scale < 1.0 else img

        for quality in [85, 60, 40, 25]:
            buf = io.BytesIO()
            resized.save(buf, format='JPEG', quality=quality, optimize=True)
            result = buf.getvalue()
            if len(result) <= target_bytes:
                return base64.b64encode(result).decode('ascii'), 'image/jpeg'

    # 最后兜底：强制缩到很小
    resized = img.resize((400, int(400 * img.size[1] / img.size[0])), Image.LANCZOS)
    buf = io.BytesIO()
    resized.save(buf, format='JPEG', quality=20, optimize=True)
    return base64.b64encode(buf.getvalue()).decode('ascii'), 'image/jpeg'


def main():
    data = json.loads(sys.stdin.read())
    images = data['images']
    max_total = data.get('max_total_bytes', 8000000)

    # 计算当前总大小
    total = sum(len(img['data']) for img in images)

    if total <= max_total:
        # 不需要压缩
        json.dump({"images": images}, sys.stdout)
        return

    # 每张图的目标大小（均分，留 10% 余量）
    per_image_target_b64 = int(max_total * 0.9 / len(images))
    # 对应的原始字节数（base64 膨胀约 33%）
    per_image_target_bytes = int(per_image_target_b64 * 3 / 4)

    result = []
    for img in images:
        b64_data = img['data']
        if len(b64_data) <= per_image_target_b64:
            result.append(img)
        else:
            raw = base64.b64decode(b64_data)
            new_b64, new_type = compress_image(raw, img['media_type'], per_image_target_bytes)
            result.append({"data": new_b64, "media_type": new_type})

    json.dump({"images": result}, sys.stdout)


if __name__ == '__main__':
    main()
