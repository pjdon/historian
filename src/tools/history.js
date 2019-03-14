'use strict';

function HistoryVisitFinder() {
  /* Collection of wrappers over history.search WebExtensions API for finding merged HistoryItem and HistoryVisitItem objects collections based on query containing text and date constraints */

  /* Largest value of `maxResults` property that is accepted by the `query` argument of browser.history.search().
  Workaround for inability to ensure that all results are provided for a date range search without the significant overhead of multiple overlapping searches */
  const maxResultsCeiling = Math.pow(2, 52);
  const defaultText = '';
  const defaultStartDatetime = new Date(0);
  const defaultFilterConfig = {
    excludeProtocolChange: true,
    excludeReloadTransition: true
  }

  /* Splits url at the protocol end */
  const urlSplitProtocolRest = new RegExp(/(^[^:\/]+:\/\/)(.+)/i);

  function getUrlAfterProtocol(url) {
    /* Get the part of the URL after the protocol */
    return url.match(urlSplitProtocolRest)[2];
  }

  this.getVisitsData = async function ({
    text = defaultText, startDatetime = defaultStartDatetime,
    endDatetime = new Date(), maxVisits = maxResultsCeiling
  } = {}) {
    /*
    Find objects representing webpage history visits whose domain and/or url
    contain `text` and whose visit datetimes are within the inclusive range of
    `startDatetimeMs` to `endDatetimeMs`.

    Returns an array of objects with the associated HistoryItem and VisitItem
    properties:
      { url:String, title:String, datetime:Number, id:String, referringVisitId:String, transition:TransitionType, }

    Returned array will be of length `maxVisits` at most, with fewer visits returned when fewer are provided by the API based on the query.

    Returns `null` if no HistoryItems are returned by the query, which means there are no results in the specified timeframe.

    TODO: optimize visit search
      * letting n = maxVisitCount
      * when the visits for each item are being filtered by datetime, only
        collect the visits that later than the nth latest visit
        given that at least n visits have been collected
      * this requires an extra sort when more than n visits have been collected
      * optionally the nth latest visit and the start-datetime threshold can be
        restablished at each HistoryItem iteration by maintaining a sorted structure
    */

    const query = {
      text,
      startTime: startDatetime.getTime(),
      endTime: endDatetime.getTime(),
      maxResults: maxVisits
    };

    const visitArray = [];
    const historyItemArray = await browser.history.search(query);
    const duePromises = [];

    if (historyItemArray.length <= 0) return null;

    const visitInDateRange = visit =>
      visit.visitTime <= query.endTime && visit.visitTime >= query.startTime;

    /* Store the visits of each HistoryItem that fall between `startTime` and
    `endTime` */
    for (let historyItem of historyItemArray) {
      const url = historyItem.url;
      const title = historyItem.title;

      const combineVisitProperties = function (visit) {
        return {
          url, title,
          datetime: visit.visitTime,
          id: visit.visitId,
          referringVisitId: visit.referringVisitId,
          transition: visit.transition,
        }
      }

      duePromises.push(browser.history.getVisits({ url })
        .then(visitItemArray => {
          visitArray.push(...(
            visitItemArray
              .filter(visitInDateRange)
              .map(combineVisitProperties)
          ))
        })
        .catch(reason => {
          console.warn('Could not get visits for HistoryItem', historyItem,
            'Reason:', reason);
        })
      );
    }

    return await Promise.all(duePromises).then(() => {
      visitArray.sort((a, b) => b.datetime - a.datetime);
      /* If we are not expecting all (at most 2^52) results within a date range then only the first `maxVisits` visits are guaranteed to be sequential, since visits for HistoryItems can be outside of the specified date range */
      if (maxVisits != maxResultsCeiling) {
        return visitArray.slice(0, maxVisits);
      } else {
        return visitArray;
      }
    });
  }

  function getVisitFilterFn(filterConfig) {
    /* Returns a function that filters visits based on `filterConfig` */
    return function (value, index, array) {
      if (index > 0) {
        /* exclude when next visit only changes the protocol */
        if (filterConfig.excludeProtocolChange == true) {
          if (getUrlAfterProtocol(value.url)
            == getUrlAfterProtocol(array[index - 1].url)) {
            return false;
          }
        }
      } else {
        /* exclude when transition is reload */
        if (filterConfig.excludeReloadTransition == true) {
          if (value.transition == 'reload') {
            return false;
          }
        }
      }
      return true;
    }
  }

  function visitMapFn(value, index, array) {
    /* Convert visit object into an entry configuration
    { url:String, title:String, datetime:Date }
    */
    return {
      url: value.url, title: value.title, datetime: new Date(value.datetime)
    };
  }

  function processVisitsData(visitsData, filterConfig) {
    const filterFn = getVisitFilterFn(filterConfig);
    return visitsData.filter(filterFn).map(visitMapFn);
  }

  /* TODO: searchVisits */
  this.searchVisits = async function ({
    text = defaultText, startDatetime = defaultStartDatetime,
    endDatetime = new Date(), maxVisits = maxResultsCeiling,
    filterConfig = defaultFilterConfig
  } = {}) {
    /* Returns filtered and formatted item-visit combined objects obtained from `getVisitData` */

    const storedVisits = [];
    const query = { text, defaultText, startDatetime, endDatetime };

    /* Continuously search for visits until enough are found or none left */
    while (storedVisits.length < maxVisits) {
      query.maxVisits = maxVisits - storedVisits.length;
      const visitsData = await this.getVisitsData(query);

      if (visitsData == null) {
        if (storedVisits.length <= 0) {
          return null;
        } else {
          break;
        }
      } else {
        storedVisits.push(...visitsData);
        if (storedVisits.length >= maxVisits) {
          break;
        }
      }
    }

    return processVisitsData(storedVisits, filterConfig);
  }
}


function HistoryVisitStreamer({
  text = "", endDatetime = new Date(), startDatetime = new Date(0), defaultMaxVisits = 100
} = {}) {
  /* Manages the on-demand sequential querying of history visit objects in reverse chronological order starting at `endDateTime` (latest) until `startDateTime` (earliest) and matching `text`.
  */

  const finder = new HistoryVisitFinder();
  /* cursor moves backward in time to act at as the `endDatetime` for each successive `getNext` query */
  let cursorDatetime = endDatetime;
  let reachedEnd = false;

  function updateCursorDatetime(visits) {
    cursorDatetime = new Date(visits[visits.length - 1]
      .datetime.getTime() - 1);
    if (cursorDatetime.getTime() < startDatetime.getTime()) {
      reachedEnd = true;
    }
  }

  this.getNext = async function (maxVisits = defaultMaxVisits) {
    /* Returns an array of filtered and processed objects representing the combined attributes of HistoryItem and HistoryVisit. The array is length `maxVisits` unless no more visits are available to retrieve. */

    if (reachedEnd) return null;

    const query = { text, maxVisits, endDatetime: cursorDatetime };
    const visitItems = await finder.searchVisits(query);

    if (visitItems.length > 0) {
      updateCursorDatetime(visitItems);
      return visitItems;
    } else {
      reachedEnd = true;
      return null;
    }

  };

}