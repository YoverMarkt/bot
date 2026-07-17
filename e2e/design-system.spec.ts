import { expect, test } from '@playwright/test'

test('cliente y superadmin comparten tipografía, labels y botones', async ({ browser }) => {
  const context = await browser.newContext()
  const client = await context.newPage()
  const admin = await context.newPage()

  await Promise.all([
    client.goto('http://127.0.0.1:4173/app/#/login'),
    admin.goto('http://127.0.0.1:4174/app-admin/#/login'),
  ])

  const styles = async (page: typeof client) => page.evaluate(() => {
    const label = document.querySelector('label')!
    const button = document.querySelector('[data-slot="button"]')!
    const labelStyle = getComputedStyle(label)
    const buttonStyle = getComputedStyle(button)
    return {
      fontFamily: getComputedStyle(document.documentElement).fontFamily,
      labelColor: labelStyle.color,
      labelSize: labelStyle.fontSize,
      labelWeight: labelStyle.fontWeight,
      buttonHeight: button.getBoundingClientRect().height,
      buttonCursor: buttonStyle.cursor,
    }
  })

  const [clientStyles, adminStyles] = await Promise.all([styles(client), styles(admin)])
  expect(clientStyles).toEqual(adminStyles)
  expect(clientStyles.buttonHeight).toBe(36)
  expect(clientStyles.buttonCursor).toBe('pointer')

  await context.close()
})
