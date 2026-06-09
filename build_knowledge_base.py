"""
知识库向量索引构建脚本 v2
支持两种数据源：
  A. 多个 JSON 文件放在 data_export/ 目录
  B. 单个备份文件 data_export/**/full_backup.json（自动检测）

用法：python build_knowledge_base.py
输出：src/js/knowledge_base_data.json（供 index_loader.js 异步加载）
"""
import json, re, sys, hashlib
from pathlib import Path
from collections import OrderedDict

# ===== 配置 =====
DATA_DIR = Path("./data_export")
OUTPUT_FILE = Path("src/js/knowledge_base_data.json")
CHUNK_SIZE = 300             # 减小切片（降低文本体积）
CHUNK_OVERLAP = 40            # 减小重叠
MAX_TOTAL_CHUNKS = 5000       # 总量上限（约 5-8MB，gzip后 1-2MB）
MAX_ISSUE_CHUNKS = 1500       # 检查信息上限
MAX_RULE_CHUNKS = 2000        # 规章制度上限
# ==================

FIELD_LABELS = {
    "content": "内容", "title": "标题", "keyword": "关键词",
    "category": "分类", "trade": "专业", "regulation": "法规依据",
    "standard": "标准", "method": "检查方法", "penalty": "处罚标准",
    "chapter": "章", "section": "节", "item": "条", "subitem": "款",
    "单位": "单位", "站名": "站名", "线名": "线名",
    "性质": "性质", "datetime": "时间", "work": "工作内容",
    "issues": "问题", "fileName": "文件名", "matType": "资料类型",
    "description": "描述", "answer": "答案", "要求": "要求",
    "检查项目": "检查项目", "检查内容": "检查内容",
    "备注": "备注", "路电": "路电", "市电": "市电",
    "name": "名称", "rawText": "文本",
}


def split_text(text, chunk_size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    """按语义边界切片"""
    if not text or not isinstance(text, str):
        return []
    sentences = re.split(r'(?<=[。！？；\.\!\?\n])', text)
    chunks, current = [], ""
    for sen in sentences:
        sen = sen.strip()
        if not sen: continue
        if len(current) + len(sen) > chunk_size and current:
            chunks.append(current)
            current = current[-overlap:] + sen if len(current) > overlap else sen
        else:
            current += sen
    if current.strip():
        chunks.append(current.strip())
    return chunks


def classify_file(filename):
    """根据文件名映射到数据类型"""
    name = filename.lower().replace('(2)', '').strip()
    if '规章' in name: return '规章制度'
    if '检查信息' in name or '问题' in name: return '检查信息'
    if '手册' in name: return '检查手册'
    if '电话' in name or '通讯' in name: return '车站电话'
    if '日志' in name or '工作' in name: return '工作日志'
    if '写作' in name or '资料' in name: return '写作资料'
    return '其他'


def extract_from_individual_files(json_files):
    """
    从独立 JSON 文件中提取文本块
    根据文件名自动识别类型
    """
    all_chunks = []
    stats = {}

    for jf in json_files:
        ftype = classify_file(jf.name)
        with open(jf, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        records = data if isinstance(data, list) else []
        if not isinstance(records, list):
            records = [data]
        
        # 规章制度特殊处理：1条记录含 data 数组
        if ftype == '规章制度' and len(records) == 1 and isinstance(records[0], dict) and 'data' in records[0]:
            records = records[0]['data']
        
        chunks = []
        seen = set()
        
        for i, r in enumerate(records):
            if not isinstance(r, dict):
                continue
            
            if ftype == '检查信息':
                text = f"{r.get('性质','')} {r.get('content','')}".strip()
                text = text[:300]
                if len(text) < 8: continue
                h = hashlib.md5(text[:120].encode()).hexdigest()
                if h in seen: continue
                seen.add(h)
                chunks.append({'t': text, 's': ftype, 'f': r.get('性质','问题'), 'r': i})
                if len(chunks) >= MAX_ISSUE_CHUNKS: break
            
            elif ftype == '规章制度':
                text = f"{r.get('title','')} {r.get('content','')}".strip()
                if len(text) < 10: continue
                for ci, chunk in enumerate(split_text(r.get('content',''), CHUNK_SIZE)):
                    if len(chunk) < 30: break
                    chunks.append({'t': chunk, 's': ftype, 'f': r.get('trade','条款'), 'r': i})
                if MAX_RULE_CHUNKS and len(chunks) >= MAX_RULE_CHUNKS: break
            
            elif ftype == '检查手册':
                parts = []
                for fld in ['chapter','section','item','subitem','content']:
                    v = str(r.get(fld,'')).strip()
                    if v: parts.append(v)
                text = '；'.join(parts)
                if len(text) < 5: continue
                chunks.append({'t': text[:400], 's': ftype, 'f': r.get('chapter','手册'), 'r': i})
            
            elif ftype == '车站电话':
                parts = []
                for fld in ['站名','单位','线名','市电','路电','备注']:
                    v = str(r.get(fld,'')).strip()
                    if v: parts.append(v)
                text = '；'.join(parts)
                if len(text) < 5: continue
                chunks.append({'t': text, 's': ftype, 'f': r.get('站名','通讯'), 'r': i})
            
            elif ftype == '工作日志':
                work = str(r.get('work','')).strip()
                issues_list = r.get('issues') or []
                issues_text = '；'.join(str(x) for x in issues_list if x)
                text = f"{r.get('date','')} {work} {issues_text}".strip()
                if len(text) < 5: continue
                chunks.append({'t': text[:300], 's': ftype, 'f': '日志', 'r': i})
        
        stats[ftype] = len(chunks)
        all_chunks.extend(chunks)
        print(f"   {ftype}: {len(records)} 条 → {len(chunks)} 块")
    
    return all_chunks, stats


def main():
    print("=" * 60)
    print("📚 铁路安监系统 · 知识库向量索引构建 v2")
    print("=" * 60)
    
    if not DATA_DIR.exists():
        print(f"\n❌ data_export/ 目录不存在，正在创建...")
        DATA_DIR.mkdir(parents=True)
        print("   请将导出的 JSON 文件（或 full_backup.json）放入此目录后重试")
        sys.exit(1)
    
    # 优先使用独立 JSON 文件（按文件名识别类型）
    json_files = sorted(DATA_DIR.glob("*.json"))
    if not json_files:
        # 回退：检测 full_backup.json
        backup_files = list(DATA_DIR.rglob("full_backup.json"))
        if backup_files:
            bf = backup_files[0]
            size_mb = bf.stat().st_size / (1024 * 1024)
            print(f"\n📂 检测到备份文件: {bf.name} ({size_mb:.1f}MB)")
            print(f"   请使用系统「全局备份」导出后，将各个 JSON 文件放入 data_export/")
            sys.exit(1)
        else:
            print(f"\n❌ 未找到任何 JSON 文件")
            sys.exit(1)
    
    print(f"\n📂 发现 {len(json_files)} 个 JSON 文件:")
    for jf in json_files:
        size_kb = jf.stat().st_size / 1024
        ftype = classify_file(jf.name)
        print(f"   · {jf.name} ({size_kb:.0f}KB) → {ftype}")
    
    print(f"\n🔍 正在提取文本...")
    all_chunks, stats = extract_from_individual_files(json_files)
    
    # 总量控制
    if MAX_TOTAL_CHUNKS and len(all_chunks) > MAX_TOTAL_CHUNKS:
        print(f"\n  ⚠️ 总块数 {len(all_chunks)} 超过上限 {MAX_TOTAL_CHUNKS}，按比例裁剪...")
        max_per_cat = {
            "规章制度": int(MAX_TOTAL_CHUNKS * 0.30),
            "检查信息": int(MAX_TOTAL_CHUNKS * 0.30),
            "检查手册": int(MAX_TOTAL_CHUNKS * 0.20),
            "写作资料": int(MAX_TOTAL_CHUNKS * 0.10),
            "车站电话": int(MAX_TOTAL_CHUNKS * 0.05),
            "工作日志": int(MAX_TOTAL_CHUNKS * 0.05),
        }
        kept = []
        for cat in ["规章制度", "检查信息", "检查手册", "写作资料", "车站电话", "工作日志"]:
            cat_chunks = [c for c in all_chunks if c["s"] == cat]
            take = min(len(cat_chunks), max_per_cat.get(cat, 200))
            kept.extend(cat_chunks[:take])
            if take < len(cat_chunks):
                print(f"    裁剪 {cat}: {len(cat_chunks)} → {take}")
        all_chunks = kept
    
    # 去重
    print(f"\n📊 去重前: {len(all_chunks)} 块")
    seen = set()
    deduped = []
    for c in all_chunks:
        key = c["t"][:80]
        if key not in seen:
            seen.add(key)
            deduped.append(c)
    print(f"📊 去重后: {len(deduped)} 块")
    
    if len(deduped) == 0:
        print("❌ 没有可索引的内容")
        sys.exit(1)
    
    # 向量化
    print(f"\n🧠 正在向量化...")
    from sentence_transformers import SentenceTransformer
    import numpy as np
    
    model_name = "paraphrase-multilingual-MiniLM-L12-v2"
    print(f"   模型: {model_name}")
    model = SentenceTransformer(model_name)
    
    texts = [c["t"] for c in deduped]
    print(f"   处理 {len(texts)} 条文本（可能需要 1-3 分钟）...")
    
    embeddings = model.encode(texts, batch_size=256, show_progress_bar=True, convert_to_numpy=True)
    embeddings = embeddings.astype(np.float16)
    
    # 组装输出
    output_chunks = []
    for i, chunk in enumerate(deduped):
        output_chunks.append({
            "e": embeddings[i].tolist(),
            "t": chunk["t"],
            "s": chunk["s"],
            "f": chunk["f"]
        })
    
    # 输出纯 JSON（由 index_loader.js 异步加载）
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_chunks, f, ensure_ascii=False)
    
    file_size_mb = OUTPUT_FILE.stat().st_size / (1024 * 1024)
    print(f"\n{'=' * 60}")
    print(f"✅ 知识库索引已生成!")
    print(f"   文件: {OUTPUT_FILE}")
    print(f"   大小: {file_size_mb:.1f}MB")
    print(f"   记录: {len(output_chunks)} 条")
    print(f"\n📊 来源统计:")
    for cat, count in stats.items():
        print(f"   {cat}: {count} 块")
    print(f"\n🚀 部署到 GitHub Pages 后即可生效")


if __name__ == "__main__":
    main()
