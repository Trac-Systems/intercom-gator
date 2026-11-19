// Unknown route.
export default {
  load: async () => null,
  html: () => ({ title: 'Not found', wide: true, main: '<div class="empty-state" style="padding-top:80px"><b>Nothing here.</b><a class="lnk" href="#/">Back to Markets</a></div>' }),
};
