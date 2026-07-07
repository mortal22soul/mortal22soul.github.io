import type { Site, Metadata, Socials } from "@types";

export const SITE: Site = {
  NAME: "Aryan Mehesare",
  EMAIL: "aryanmehesare@gmail.com",
  NUM_POSTS_ON_HOMEPAGE: 2,
  NUM_WORKS_ON_HOMEPAGE: 2,
  NUM_PROJECTS_ON_HOMEPAGE: 4,
};

export const HOME: Metadata = {
  TITLE: "Home",
  DESCRIPTION:
    "AI/ML & DevOps Engineer building AI-driven systems and full-stack applications. Looking for full-time opportunities in software engineering, AI/ML, and DevOps roles.",
};

export const BLOG: Metadata = {
  TITLE: "Blog",
  DESCRIPTION: "A collection of articles on topics I am passionate about.",
};

export const WORK: Metadata = {
  TITLE: "Work",
  DESCRIPTION:
    "My internships and professional experience in AI/ML, DevOps, and full-stack development.",
};

export const PROJECTS: Metadata = {
  TITLE: "Projects",
  DESCRIPTION:
    "A collection of my projects spanning AI/ML, audio forensics, image super-resolution, IoT safety platforms, and DevOps pipelines.",
};

export const SOCIALS: Socials = [
  {
    NAME: "resume",
    HREF: "Aryan-Mehesare-Resume-2026.pdf",
  },
  {
    NAME: "github",
    HREF: "https://github.com/mortal22soul",
  },
  {
    NAME: "linkedin",
    HREF: "https://www.linkedin.com/in/aryanmehesare",
  },
];
