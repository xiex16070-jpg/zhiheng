/**
 * multipart/form-data 解析（零依赖）。
 * 只处理文件上传需要的子集：字段名、文件名、内容类型、原始字节。
 */

/**
 * @param {Buffer} buffer 完整请求体
 * @param {string} boundary
 * @returns {Array<{name:string, filename:string, contentType:string, data:Buffer}>}
 */
export function parseMultipart(buffer, boundary) {
  if (!boundary) throw new Error('missing_boundary');
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];

  let pos = buffer.indexOf(delim);
  if (pos < 0) return parts;
  pos += delim.length;

  while (pos < buffer.length) {
    // 结束标记 `--`
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break;
    // 跳过 CRLF
    if (buffer[pos] === 0x0d && buffer[pos + 1] === 0x0a) pos += 2;

    const headEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;

    const headText = buffer.subarray(pos, headEnd).toString('utf8');
    const dataStart = headEnd + 4;

    const next = buffer.indexOf(delim, dataStart);
    const dataEnd = next < 0 ? buffer.length : next;
    // 去掉数据尾部多出的 CRLF
    let end = dataEnd;
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;

    const nameMatch = /name="([^"]*)"/i.exec(headText);
    const fileMatch = /filename="([^"]*)"/i.exec(headText);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headText);

    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch ? fileMatch[1] : '',
      contentType: typeMatch ? typeMatch[1].trim() : '',
      data: buffer.subarray(dataStart, Math.max(dataStart, end)),
    });

    if (next < 0) break;
    pos = next + delim.length;
  }

  return parts;
}

/** 从 content-type 头里取 boundary */
export function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  return m ? (m[1] || m[2]).trim() : '';
}
