import { describe, expect, it } from "vitest";
import {
  createPullRequestUrl,
  parseRemoteWebUrl,
} from "./remoteWebUrl";

const GH = parseRemoteWebUrl("git@github.com:owner/repo.git")!;
const GL = parseRemoteWebUrl("https://gitlab.com/owner/repo.git")!;
const BB = parseRemoteWebUrl("https://bitbucket.org/owner/repo.git")!;

describe("createPullRequestUrl", () => {
  it("GitHub: compare URL with expand + branch refspec", () => {
    const url = createPullRequestUrl(GH, "feat/x", "main");
    expect(url).toBe(
      "https://github.com/owner/repo/compare/main...feat%2Fx?expand=1",
    );
  });

  it("GitHub: defaults base to main when absent", () => {
    const url = createPullRequestUrl(GH, "feat/x");
    expect(url).toContain("/compare/main...feat%2Fx");
  });

  it("GitLab: merge_request params", () => {
    const url = createPullRequestUrl(GL, "feat/x", "main");
    expect(url).toContain("/-/merge_requests/new?");
    expect(url).toContain("merge_request%5Bsource_branch%5D=feat%2Fx");
    expect(url).toContain("merge_request%5Btarget_branch%5D=main");
  });

  it("Bitbucket: source/dest params", () => {
    const url = createPullRequestUrl(BB, "feat/x", "main");
    expect(url).toBe(
      "https://bitbucket.org/owner/repo/branch/pull-request/new?source=feat%2Fx&dest=main",
    );
  });

  it("non-hosted remotes do not parse", () => {
    expect(parseRemoteWebUrl("https://git.company.local/owner/repo.git")).toBeNull();
  });
});
