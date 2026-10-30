// RIFF/VP8/VP8L/VP8X container fields: https://developers.google.com/speed/webp/docs/riff_container
// Inspect bounded container structure; Meta still validates the encoded image on upload.
export function readAttentionSticker(bytes: Uint8Array): { width: number; height: number; animated: boolean } | null {
  const data=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(data.length<26 || data.length>500*1024 || data.toString("ascii",0,4)!=="RIFF" || data.toString("ascii",8,12)!=="WEBP" || data.readUInt32LE(4)+8!==data.length)return null;
  type Chunk={name:string;data:Buffer};let visited=0;
  function chunks(buffer:Buffer,start:number):Chunk[]|null {
    const result:Chunk[]=[];
    for(let p=start;p<buffer.length;) {
      if(p+8>buffer.length || ++visited>4096)return null;
      const size=buffer.readUInt32LE(p+4),end=p+8+size,padded=end+(size%2);
      if(end>buffer.length || padded>buffer.length || (size%2 && buffer[end]!==0))return null;
      result.push({name:buffer.toString("ascii",p,p+4),data:buffer.subarray(p+8,end)});p=padded;
    }
    return result;
  }
  function dimensions(chunk:Chunk):{width:number;height:number}|null {
    const b=chunk.data;
    if(chunk.name==="VP8 " && b.length>=10 && (b[0]&1)===0 && b[3]===0x9d && b[4]===1 && b[5]===0x2a)
      return {width:b.readUInt16LE(6)&0x3fff,height:b.readUInt16LE(8)&0x3fff};
    if(chunk.name==="VP8L" && b.length>=5 && b[0]===0x2f) {
      const bits=b.readUInt32LE(1);if(bits>>>29)return null;
      return {width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1};
    }
    return null;
  }
  const top=chunks(data,12);if(!top?.length)return null;
  const extended=top.filter(c=>c.name==="VP8X"),pictures=top.filter(c=>c.name==="VP8 "||c.name==="VP8L");
  const animation=top.filter(c=>c.name==="ANIM"),frames=top.filter(c=>c.name==="ANMF");
  if(!extended.length) {
    if(pictures.length!==1 || animation.length || frames.length)return null;
    const size=dimensions(pictures[0]);return size&&size.width>0&&size.height>0?{...size,animated:false}:null;
  }
  const x=extended[0].data;
  if(extended.length!==1 || top[0]!==extended[0] || x.length!==10 || (x[0]&0xc1) || x[1] || x[2] || x[3])return null;
  const width=x.readUIntLE(4,3)+1,height=x.readUIntLE(7,3)+1,animated=Boolean(x[0]&2);
  if(!animated) {
    if(animation.length || frames.length || pictures.length!==1)return null;
    const size=dimensions(pictures[0]);return size?.width===width&&size.height===height?{width,height,animated:false}:null;
  }
  if(animation.length!==1 || animation[0].data.length!==6 || !frames.length || pictures.length || top.indexOf(animation[0])>top.indexOf(frames[0]))return null;
  for(const frame of frames) {
    const f=frame.data;if(f.length<24 || (f[15]&0xfc))return null;
    const left=f.readUIntLE(0,3)*2,upper=f.readUIntLE(3,3)*2,w=f.readUIntLE(6,3)+1,h=f.readUIntLE(9,3)+1;
    if(left+w>width || upper+h>height)return null;
    const children=chunks(f,16);if(!children)return null;
    const images=children.filter(c=>c.name==="VP8 "||c.name==="VP8L");
    if(images.length!==1 || children.some(c=>!["VP8 ","VP8L","ALPH"].includes(c.name)))return null;
    const size=dimensions(images[0]);if(size?.width!==w || size.height!==h)return null;
  }
  return {width,height,animated:true};
}
