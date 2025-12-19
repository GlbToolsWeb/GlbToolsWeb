// Placeholder worker: in the next step we'll port the full atlas pipeline here.
// For now, it echoes back the first GLB file unchanged to keep UI flow intact.

self.onmessage = async (event) => {
  const { files } = event.data || {};
  if (!files || !files.length) {
    self.postMessage({ error: 'No files provided' });
    return;
  }

  try {
    // Expect File/Blob array; take first.
    const file = files[0];
    const arrayBuffer = await file.arrayBuffer();
    // Echo back as base64 so UI stays consistent with prior shape.
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    self.postMessage({ glb: base64, layout: [] });
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};

