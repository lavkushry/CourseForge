import asyncio
from playwright.async_api import async_playwright

async def inspect():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={'width': 1366, 'height': 768})
        page = await context.new_page()
        await page.goto('http://127.0.0.1:8000')
        await page.wait_for_selector('#appShell', timeout=5000)
        await asyncio.sleep(1)

        # Inspect topbar elements
        topbar_info = await page.evaluate('''() => {
            const topbar = document.querySelector('.topbar');
            const crumb = document.querySelector('.topbar-crumb');
            const nav = document.querySelector('.topbar-nav');
            const search = document.querySelector('.global-search');
            const input = document.querySelector('#globalSearch');
            const kbd = document.querySelector('.global-search kbd');
            const actions = document.querySelector('.topbar-actions');
            const chip = document.querySelector('.privacy-chip');
            const scan = document.querySelector('#scanBtn');
            const avatar = document.querySelector('#avatarBtn');

            const getRect = (el) => el ? {
                display: window.getComputedStyle(el).display,
                x: el.getBoundingClientRect().x,
                y: el.getBoundingClientRect().y,
                width: el.getBoundingClientRect().width,
                height: el.getBoundingClientRect().height
            } : null;

            return {
                topbar: getRect(topbar),
                crumb: getRect(crumb),
                nav: getRect(nav),
                search: getRect(search),
                input: getRect(input),
                kbd: getRect(kbd),
                actions: getRect(actions),
                chip: getRect(chip),
                scan: getRect(scan),
                avatar: getRect(avatar),
                searchScrollWidth: input ? input.scrollWidth : 0,
                searchClientWidth: input ? input.clientWidth : 0,
                placeholderText: input ? input.placeholder : ''
            };
        }''')
        print('TOPBAR INFO at 1366px:', topbar_info)

        # Billboard buttons
        billboard_info = await page.evaluate('''() => {
            const btns = Array.from(document.querySelectorAll('.billboard-actions button')).map(b => ({
                text: b.innerText.trim(),
                x: b.getBoundingClientRect().x,
                y: b.getBoundingClientRect().y,
                width: b.getBoundingClientRect().width,
                height: b.getBoundingClientRect().height
            }));
            return btns;
        }''')
        print('BILLBOARD ACTIONS at 1366px:', billboard_info)

        await page.screenshot(path='/home/ubuntu/CourseForge/screen_1366.png')
        await browser.close()

asyncio.run(inspect())
