from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional

class BasePlatformAdapter(ABC):
    """
    Abstract BasePlatformAdapter (Open/Closed Principle & Dependency Inversion).
    Scrapers, browser engines, and platform executors must implement this interface.
    """

    @abstractmethod
    def login(self) -> bool:
        """Authenticates with the target job platform."""
        pass

    @abstractmethod
    def bump_profile(self) -> Dict[str, Any]:
        """
        Touches profile timestamp (Resdex / Activity bump) to refresh
        ranking and boost visibility to 'Active Today'.
        """
        pass

    @abstractmethod
    def search_and_apply(self, query: str, limit: int = 15, dry_run: bool = False) -> List[Dict[str, Any]]:
        """
        Searches vacancies matching query criteria and submits 1-Click / Easy Apply
        applications, returning metadata of processed applications.
        """
        pass

    @abstractmethod
    def send_recruiter_pitch(self, lead: Dict[str, Any], dry_run: bool = False) -> bool:
        """Dispatches personalized recruiter outreach / connection message."""
        pass

    @abstractmethod
    def extract_metrics(self) -> Dict[str, Any]:
        """Extracts search appearances, profile views, and contact views."""
        pass
