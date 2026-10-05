import * as db from '../lib/db.js';
import { buildHtml, downloadFile, safeFilename } from '../lib/export.js';

const id = new URLSearchParams(location.search).get('id');
const $ = (s) => document.querySelector(s);

async function init() {
  const video = id ? await db.getVideo(id) : null;
  if (!video) {
    $('#msg').hidden = false;
    $('#msg').textContent = id ? 'This video is no longer in your library.' : 'Choose a video in the library and click "Print or PDF".';
    return;
  }
  const notes = await db.getNotes(id);
  const html = buildHtml(video, notes);
  document.title = `${video.title || 'Video'} - print`;
  $('#title').textContent = video.title || 'Untitled video';
  const frame = $('#frame');
  frame.srcdoc = html;
  frame.hidden = false;
  $('#print').disabled = false;
  $('#download').disabled = false;
  $('#print').addEventListener('click', () => frame.contentWindow.print());
  $('#download').addEventListener('click', () => downloadFile(safeFilename(video.title, 'html'), html, 'text/html'));
}

init();
