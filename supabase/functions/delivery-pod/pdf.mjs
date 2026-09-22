// Generate a PDF from validated, upright JPEG page copies. Originals stay separate.
const text = value => new TextEncoder().encode(value);
export function jpegSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 20 || bytes.length > 8_000_000 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw Error('INVALID_JPEG_PAGE');
  for (let offset=2;offset+9<bytes.length;) {
    if(bytes[offset++]!==255)throw Error('INVALID_JPEG_PAGE');
    while(bytes[offset]===255)offset++;
    const marker=bytes[offset++];if(marker===218||marker===217)break;
    const length=bytes[offset]*256+bytes[offset+1];if(length<2||offset+length>bytes.length)throw Error('INVALID_JPEG_PAGE');
    if(marker===192||marker===194){const height=bytes[offset+3]*256+bytes[offset+4],width=bytes[offset+5]*256+bytes[offset+6],channels=bytes[offset+7];
      if(bytes[offset+2]!==8||!width||!height||width*height>24_000_000||![1,3].includes(channels))throw Error('INVALID_JPEG_PAGE');
      return {width,height,channels};}
    offset+=length;
  }throw Error('INVALID_JPEG_PAGE');
}
export function makePdf(pages) {
  if(!Array.isArray(pages)||pages.length<1||pages.length>10)throw Error('INVALID_PAGE_COUNT');
  const objects=[null,null],kids=[];
  pages.forEach(bytes=>{
    const {width,height,channels}=jpegSize(bytes),pageId=objects.length+1,imageId=pageId+1,contentId=pageId+2;
    const scale=Math.min(576/width,756/height),w=width*scale,h=height*scale;
    const content=text(`q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} ${((612-w)/2).toFixed(3)} ${((792-h)/2).toFixed(3)} cm /Im0 Do Q`);
    kids.push(`${pageId} 0 R`);
    objects.push([text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`)],
      [text(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${channels===1?'DeviceGray':'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`),bytes,text('\nendstream')],
      [text(`<< /Length ${content.length} >>\nstream\n`),content,text('\nendstream')]);
  });
  objects[0]=[text('<< /Type /Catalog /Pages 2 0 R >>')];objects[1]=[text(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`)];
  const chunks=[text('%PDF-1.4\n')],offsets=[0];let length=chunks[0].length;
  const append=b=>{chunks.push(b);length+=b.length;};
  objects.forEach((parts,i)=>{offsets.push(length);append(text(`${i+1} 0 obj\n`));parts.forEach(append);append(text('\nendobj\n'));});
  const xref=length;append(text(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const output=new Uint8Array(length);let pos=0;chunks.forEach(b=>{output.set(b,pos);pos+=b.length;});return output;
}
