/* eslint-disable @typescript-eslint/explicit-function-return-type -- Chromium evaluates this function as plain JavaScript. */
// Discover the pages from the sidebar so new entries are checked too.
export async function checkPageWidths() {
  const main = document.querySelector('main')
  const waitForRender = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  function checkPage(label) {
    const page = main.querySelector(':scope > section:not([hidden])')
    const header = page?.querySelector('header')
    if (!header) throw Error(label + ': missing visible page header')
    const css = getComputedStyle(main)
    const left = main.getBoundingClientRect().left + main.clientLeft + parseFloat(css.paddingLeft)
    const right = left + main.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)
    // Compare actual content edges to the shell, not to a potentially capped page wrapper.
    for (const block of [page, ...header.parentElement.children]) {
      if (!block.getClientRects().length) continue
      const rect = block.getBoundingClientRect()
      if (Math.abs(rect.left - left) > 1 || Math.abs(rect.right - right) > 1) {
        throw Error(`${label} at ${innerWidth}px: ${block.tagName} spans ${rect.left}–${rect.right}, expected ${left}–${right}`)
      }
    }
    if (main.scrollWidth > main.clientWidth + 1) throw Error(label + ': horizontal overflow')
    return page
  }

  const links = document.querySelectorAll('aside nav button, aside button[aria-label="软件设置"]')
  if (!links.length) throw Error('Missing sidebar navigation')
  for (const link of links) {
    const label = link.getAttribute('aria-label')
    link.click()
    await waitForRender()
    if (link.getAttribute('aria-current') !== 'page') throw Error('Navigation failed: ' + label)
    const page = checkPage(label)
    if (label === '调度任务') {
      const table = page.querySelector('table')
      if (table) {
        const right = table.getBoundingClientRect().right
        for (const button of table.querySelectorAll('button')) {
          if (button.getBoundingClientRect().right > right + 1) throw Error('Clipped schedule action')
        }
      }
      page.querySelector('header button').click()
      await waitForRender()
      if (!page.querySelector('form')) throw Error('Schedule editor did not open')
      checkPage('调度任务编辑器')
      page.querySelector('form footer [type="button"]').click()
      await waitForRender()
    }
  }
}
