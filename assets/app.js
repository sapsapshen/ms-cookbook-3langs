(() => {
  "use strict";

  const data = window.BOOK_DATA;
  const byId = new Map(data.chapters.map((chapter) => [chapter.id, chapter]));
  const elements = {
    article: document.querySelector("#article"),
    articleBody: document.querySelector("#articleBody"),
    chapterNav: document.querySelector("#chapterNav"),
    chapterNumber: document.querySelector("#chapterNumber"),
    chapterTitle: document.querySelector("#chapterTitle"),
    localToc: document.querySelector("#localToc"),
    menuButton: document.querySelector("#menuButton"),
    mobilePage: document.querySelector("#mobilePage"),
    next: document.querySelector("#nextChapter"),
    partLabel: document.querySelector("#partLabel"),
    previous: document.querySelector("#previousChapter"),
    progress: document.querySelector("#readingProgress"),
    readTime: document.querySelector("#readTime"),
    sidebar: document.querySelector("#bookSidebar"),
    sidebarClose: document.querySelector("#sidebarClose"),
    sidebarScrim: document.querySelector("#sidebarScrim"),
    tocChapterNumber: document.querySelector("#tocChapterNumber"),
    viewer: document.querySelector("#imageViewer"),
    viewerClose: document.querySelector("#viewerClose"),
    viewerImage: document.querySelector("#viewerImage")
  };

  let currentChapter = data.chapters[0];
  let headingObserver = null;
  let homeVisible = true;
  const homePage = document.querySelector("#homePage");
  const expandContents = document.querySelector("#expandContents");

  function buildHomeContents() {
    const copy = [
      ["认识开源模型", "了解开源模型的基本概念、生态与 ModelScope 平台"],
      ["从问题出发", "找到合适场景，选择模型并建立评测基线"],
      ["让模型工作起来", "从环境搭建到模型运行，快速跑通示例"],
      ["微调与评测", "数据构建、轻量微调、偏好对齐与效果评测"],
      ["业务系统实践", "企业知识问答与本地语音助手"],
      ["AIGC 特别篇", "DiffSynth 图像 LoRA 与营销内容生产线"],
      ["Agent 特别篇", "用 MCP 连接工具，用 Skill 封装任务能力"],
      ["基础知识补充", "理解大模型的基本概念与工作原理"]
    ];
    document.querySelector("#homeContents").innerHTML = data.parts.map((part, i) => `
      <details class="contents-part" id="${i === 4 ? "practice" : "contents-" + part.id}">
        <summary aria-label="${copy[i][0]}，${part.chapters.length}章">
          <span class="contents-number">${String(i + 1).padStart(2, "0")}</span>
          <div><h3>${copy[i][0]}</h3><p>${copy[i][1]}</p></div>
          <img src="assets/home/chevron.svg" alt="">
        </summary>
        <nav class="home-chapters" aria-label="${copy[i][0]}章节">${part.chapters.map(id => {
          const chapter = byId.get(id);
          return `<a href="#${id}"><span>${String(chapter.number).padStart(2, "0")}</span>${chapterTitleWithoutNumber(chapter.title)}</a>`;
        }).join("")}</nav>
      </details>`).join("");
    document.querySelectorAll(".contents-part").forEach(part => part.addEventListener("toggle", updateExpandButton));
  }

  function updateExpandButton() {
    const parts = [...document.querySelectorAll(".contents-part")];
    const allOpen = parts.every(part => part.open);
    expandContents.setAttribute("aria-expanded", String(allOpen));
    expandContents.firstChild.textContent = allOpen ? "收起完整目录 " : "查看完整目录 ";
  }

  function showHome(anchor) {
    homeVisible = true;
    document.body.classList.add("is-home");
    homePage.hidden = false;
    document.querySelector(".site-shell").hidden = true;
    document.title = `${data.title}｜从开源模型到业务实践`;
    closeMenu();
    closeViewer();
    if (headingObserver) headingObserver.disconnect();
    if (anchor === "practice") {
      document.querySelector("#practice").open = true;
    }
    requestAnimationFrame(() => {
      const target = ["contents", "paths", "practice"].includes(anchor) ? document.getElementById(anchor) : null;
      if (target) target.scrollIntoView({ block: "start", behavior: "auto" });
      else window.scrollTo({ top: 0, behavior: "instant" });
    });
  }

  function chapterTitleWithoutNumber(title) {
    return title.replace(/^第[^　\s]+章[　\s]*/, "");
  }

  function partForChapter(chapterId) {
    return data.parts.find((part) => part.chapters.includes(chapterId));
  }

  function shortPartTitle(title) {
    return title.split(/[　\s]/)[0];
  }

  function buildNavigation() {
    elements.chapterNav.innerHTML = data.parts.map((part, partIndex) => {
      const chapterLinks = part.chapters.map((id) => {
        const chapter = byId.get(id);
        return `<a href="#${chapter.id}" data-chapter="${chapter.id}">${chapter.title}</a>`;
      }).join("");
      return `<details data-part="${part.id}" ${partIndex === 0 ? "open" : ""}>
        <summary><span class="part-index">P${String(partIndex + 1).padStart(2, "0")}</span><span>${part.title}</span></summary>
        <div class="chapter-list">${chapterLinks}</div>
      </details>`;
    }).join("");
  }

  function hashState() {
    const raw = location.hash.slice(1);
    const [chapterId, headingId] = raw.split("/");
    return {
      chapter: byId.get(chapterId),
      anchor: chapterId,
      headingId: headingId || ""
    };
  }

  function updatePager(link, chapter, disabled) {
    link.classList.toggle("disabled", disabled);
    if (!chapter) return;
    link.href = `#${chapter.id}`;
    link.querySelector("span").textContent = chapterTitleWithoutNumber(chapter.title);
  }

  function renderToc(chapter) {
    elements.localToc.innerHTML = chapter.headings.map((heading) => (
      `<a href="#${chapter.id}/${heading.id}" data-heading="${heading.id}" data-level="${heading.level}">${heading.text}</a>`
    )).join("");

    elements.localToc.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const target = document.getElementById(link.dataset.heading);
        if (target) {
          history.replaceState(null, "", link.href);
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
  }

  function watchHeadings(chapter) {
    if (headingObserver) headingObserver.disconnect();
    const tocLinks = new Map([...elements.localToc.querySelectorAll("a")].map((link) => [link.dataset.heading, link]));
    headingObserver = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      tocLinks.forEach((link) => link.classList.toggle("active", link.dataset.heading === visible.target.id));
    }, { rootMargin: "-15% 0px -70% 0px", threshold: 0 });
    chapter.headings.forEach((heading) => {
      const target = document.getElementById(heading.id);
      if (target) headingObserver.observe(target);
    });
  }

  function bindImages() {
    elements.articleBody.querySelectorAll("img").forEach((image) => {
      image.addEventListener("click", () => {
        elements.viewerImage.src = image.src;
        elements.viewerImage.alt = image.alt;
        elements.viewer.hidden = false;
        document.body.style.overflow = "hidden";
      });
    });
  }

  function closeMenu() {
    elements.sidebar.classList.remove("open");
    elements.sidebarScrim.classList.remove("open");
    elements.menuButton.setAttribute("aria-expanded", "false");
  }

  function renderChapter(chapter, headingId = "") {
    homeVisible = false;
    document.body.classList.remove("is-home");
    homePage.hidden = true;
    document.querySelector(".site-shell").hidden = false;
    currentChapter = chapter;
    const index = data.chapters.indexOf(chapter);
    const part = partForChapter(chapter.id);
    const number = String(chapter.number).padStart(2, "0");

    elements.chapterNumber.textContent = number;
    elements.tocChapterNumber.textContent = number;
    elements.mobilePage.textContent = number;
    elements.chapterTitle.textContent = chapter.title;
    elements.partLabel.textContent = part ? shortPartTitle(part.title) : "正文";
    elements.readTime.textContent = `阅读约 ${chapter.minutes} 分钟`;
    elements.articleBody.innerHTML = chapter.html;
    document.title = `${chapter.title}｜${data.title}`;

    updatePager(elements.previous, data.chapters[index - 1], index === 0);
    updatePager(elements.next, data.chapters[index + 1], index === data.chapters.length - 1);
    renderToc(chapter);
    bindImages();
    watchHeadings(chapter);

    elements.chapterNav.querySelectorAll("a[data-chapter]").forEach((link) => {
      link.classList.toggle("active", link.dataset.chapter === chapter.id);
    });
    const details = elements.chapterNav.querySelector(`details[data-part="${part?.id || ""}"]`);
    if (details) details.open = true;

    closeMenu();
    requestAnimationFrame(() => {
      if (headingId && document.getElementById(headingId)) {
        document.getElementById(headingId).scrollIntoView({ block: "start" });
      } else {
        window.scrollTo({ top: 0, behavior: "instant" });
      }
      updateProgress();
    });
  }

  function updateProgress() {
    if (homeVisible) return;
    const rect = elements.article.getBoundingClientRect();
    const scrollable = Math.max(1, elements.article.offsetHeight - window.innerHeight);
    const read = Math.min(scrollable, Math.max(0, -rect.top));
    elements.progress.style.width = `${(read / scrollable) * 100}%`;
  }

  function route() {
    const state = hashState();
    if (!state.chapter) {
      showHome(state.anchor);
      return;
    }
    if (homeVisible || state.chapter.id !== currentChapter.id || !elements.articleBody.children.length) {
      renderChapter(state.chapter, state.headingId);
    } else if (state.headingId) {
      document.getElementById(state.headingId)?.scrollIntoView({ block: "start" });
    }
  }

  buildNavigation();
  buildHomeContents();
  expandContents.addEventListener("click", () => {
    const parts = [...document.querySelectorAll(".contents-part")];
    const open = !parts.every(part => part.open);
    parts.forEach(part => { part.open = open; });
    updateExpandButton();
  });
  route();
  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", updateProgress, { passive: true });
  window.addEventListener("resize", updateProgress);
  elements.menuButton.addEventListener("click", () => {
    const open = !elements.sidebar.classList.contains("open");
    elements.sidebar.classList.toggle("open", open);
    elements.sidebarScrim.classList.toggle("open", open);
    elements.menuButton.setAttribute("aria-expanded", String(open));
  });
  elements.sidebarClose.addEventListener("click", closeMenu);
  elements.sidebarScrim.addEventListener("click", closeMenu);
  document.querySelector("#backTop").addEventListener("click", (event) => {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  function closeViewer() {
    elements.viewer.hidden = true;
    elements.viewerImage.src = "";
    document.body.style.overflow = "";
  }
  elements.viewerClose.addEventListener("click", closeViewer);
  elements.viewer.addEventListener("click", (event) => {
    if (event.target === elements.viewer) closeViewer();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeViewer();
      closeMenu();
    }
    if (!homeVisible && (event.metaKey || event.ctrlKey) && event.key === "ArrowRight" && !elements.next.classList.contains("disabled")) {
      location.hash = elements.next.hash;
    }
    if (!homeVisible && (event.metaKey || event.ctrlKey) && event.key === "ArrowLeft" && !elements.previous.classList.contains("disabled")) {
      location.hash = elements.previous.hash;
    }
  });
})();
