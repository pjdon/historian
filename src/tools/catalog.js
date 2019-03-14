'use strict';

const RateLimited = function (callback, msRateLimit, limitedCallback, startLimited = false) {
  let limited = startLimited;
  const reset = () => limited = false;
  return function () {
    if (!limited) {
      limited = true;
      setTimeout(reset, msRateLimit);
      return callback();
    }
    else if (typeof limitedCallback === "function") {
      return limitedCallback();
    }
  }
}

function HistoryCatalog(containerElement, listElement) {
  const container = containerElement;
  const list = listElement;
  const streamer = new HistoryVisitStreamer();
  const bufferDist = 200;

  const template = document.createElement('template');
  template.innerHTML = `<div class='item'><a></a></div>`;

  function stdTimeFromDate(date, { pmString = 'PM', amString = 'AM' } = {}) {
    /* Get standard time format string from Date object `date`. Not zero-padded.
    e.g. "10:23 PM"
    */
    let hours = date.getHours();
    const period = hours >= 12 ? pmString : amString;
    hours = hours == 0 ? 12 : hours % 12;
    const minutes = date.getMinutes();
    return (hours + ":" + (minutes < 10 ? "0" + minutes : minutes)
      + " " + period);
  }

  function addRow(data) {
    console.log('addRow', data);
    const node = template.content.cloneNode(true);
    const div = node.firstChild;
    const link = div.firstChild;
    div.setAttribute('data-timestamp', stdTimeFromDate(data.datetime));
    div.setAttribute('title', (data.title ? data.title + "\n" : "") + data.url);
    link.textContent = data.title || data.url;
    link.href = data.url;
    list.append(node);
  }

  function addBlock() {
    streamer.getNext().then(visits => visits.forEach(addRow));
  }

  const loadOnReachedEnd = RateLimited(addBlock, 50);

  container.addEventListener('scroll', event => {
    if ((container.scrollTopMax - container.scrollTop) < bufferDist) {
      console.log('scrolled to bottom');
      loadOnReachedEnd();
    }
  });

  addBlock();
}